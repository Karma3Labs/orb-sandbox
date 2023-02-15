import  path from 'path'
import axios from "axios"
import { Pretrust, LocalTrust, GlobalTrust, Entry } from '../types'
import { objectFlip } from "./utils"
import { PretrustPicker, PretrustStrategy, strategies as pretrustStrategies } from './strategies/pretrust'
import { LocaltrustStrategy, strategies as localStrategies } from './strategies/localtrust'
import { getIds } from './utils'

// TODO: Fix that ugly thingie
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

export default class Recommender {
	public alpha: number
	public ids: number[] = []
	public idsToIndex: Record<number, number> = {}
	public localtrustPicker: LocaltrustStrategy = localStrategies.existingConnections
	public pretrustPicker: PretrustPicker = pretrustStrategies.pretrustAllEqually.picker
	public personalized = pretrustStrategies.pretrustAllEqually.personalized

	public convertedLocaltrust: LocalTrust = [] 
	public pretrust: LocalTrust = [] 
	public globaltrustEntries: Entry[] = []

	constructor(pretrustPicker: PretrustStrategy, localtrustPicker = localStrategies.follows, alpha = 0.3) {
		this.alpha = alpha
		this.localtrustPicker = localtrustPicker

		this.pretrustPicker = pretrustPicker.picker
		this.personalized = pretrustPicker.personalized
	}

	async load() {
		this.ids = await getIds()
		this.idsToIndex = objectFlip(this.ids)

		const localtrust = await this.localtrustPicker()
		this.convertedLocaltrust = this.convertLocaltrustToIndeces(localtrust)
		console.log(`Generated localtrust with ${localtrust.length} entries`)

		if (!this.personalized) {
			const pretrust = await this.pretrustPicker()
			const convertedPretrust = this.convertPretrustToIndeces(pretrust)
			console.log('Since the strategy is not personalized, we can precompute the global trust')
			console.log(`Generated pretrust with ${pretrust.length} entries`)

			this.globaltrustEntries = await this.runEigentrust(convertedPretrust, this.convertedLocaltrust)
		}

		console.log(`Loaded ${this.ids.length} profiles`)
	}

	async recommend(id: number, limit = 20) {
		if (this.personalized) {	
			// Regenerate pretrust
			const pretrust = await this.pretrustPicker(id)
			const convertedPretrust = this.convertPretrustToIndeces(pretrust)
			console.log(`Generated pretrust with ${pretrust.length} entries`)

			this.globaltrustEntries = await this.runEigentrust(convertedPretrust, this.convertedLocaltrust, id)
		}

		return this.globaltrustEntries.map(([id]) => id).slice(0, limit)
	}

	private runEigentrust = async (convertedPretrust: Pretrust, convertedLocaltrust: LocalTrust, id?: number): Promise<Entry[]> => {
		const res = await this.requestEigentrust(
			convertedLocaltrust,
			convertedPretrust,
		)

		const globaltrust = this.convertGlobalTrustToIds(res);
		const globaltrustEntries: Entry[] = globaltrust.map((entry: GlobalTrust[0]) => [entry.i, entry.v])
		globaltrustEntries.sort((a: Entry, b: Entry)  => b[1] - a[1]) 
		console.log('globalTrustEntries', globaltrustEntries)
		
		return globaltrustEntries
	}

	async requestEigentrust(localTrust: LocalTrust, pretrust: Pretrust) {
		try {
			console.time('calculation')

			const eigentrustAPI = `${process.env.EIGENTRUST_API}/basic/v1/compute`
			const res = await axios.post(eigentrustAPI, {
				localTrust: {
					scheme: 'inline',
					size: this.ids.length,
					entries: localTrust,
				},
				pretrust: {
					scheme: 'inline',
					size: this.ids.length,
					entries: pretrust,
				},
				alpha: this.alpha
			})

			console.timeEnd('calculation')
			return res.data.entries
		}
		catch (e) {
			throw new Error('Calculation did not succeed');
		}
	}

	/**
	 * Address to number conversions
	*/

	private convertLocaltrustToIndeces(localTrust: LocalTrust): LocalTrust {
		return localTrust.map(({ i, j, v }) => {
			return {
				i: +this.idsToIndex[i],
				j: +this.idsToIndex[j],
				v
			}
		}) 
	}
	
	private convertPretrustToIndeces(preTrust: Pretrust): Pretrust {
		return preTrust.map(({ i, v }) => {
			return {
				i: +this.idsToIndex[i],
				v
			}
		}) 
	}

	private convertGlobalTrustToIds(globalTrust: GlobalTrust): GlobalTrust {
		return globalTrust.map(({ i, v }) => {
			return {
				i: this.ids[i], 
				v
			}
		})
	}
}
