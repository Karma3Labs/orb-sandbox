import  path from 'path'
import axios from "axios"
import { Pretrust, LocalTrust, GlobalTrust } from '../types'
import { objectFlip, getIds } from "./utils"
import { strategies as ptStrategies  } from './strategies/pretrust'
import { strategies as ltStrategies  } from './strategies/localtrust'
import { strategies as psStrategies  } from './strategies/personalization'
import { PersonalizationStrategy, strategies as personalizationStrategies } from './strategies/personalization'
import { getDB } from '../utils'
const db = getDB()

// TODO: Fix that ugly thingie
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

export default class Recommender {
	public ids: number[] = []
	public idsToIndex: Record<number, number> = {}
	public globaltrust: GlobalTrust = []

	constructor(
		public strategyId: number,
		public personalizationStrategy?: PersonalizationStrategy,
	) {}

	async recalculate() {
		this.ids = await getIds()
		this.idsToIndex = objectFlip(this.ids)

		const strategy = await db('strategies')
			.where('id', this.strategyId)
			.first()

		const localtrustStrategy = ltStrategies[strategy.localtrust]
		const pretrustStrategy = ptStrategies[strategy.pretrust]

		console.time('localtrust_generation')
		const localtrust = await localtrustStrategy()
		console.timeEnd('localtrust_generation')
		console.log(`Generated localtrust with ${localtrust.length} entries`)

		console.time('pretrust_generation')
		const pretrust = await pretrustStrategy()
		console.timeEnd('pretrust_generation')
		console.log(`Generated localtrust with ${localtrust.length} entries`)
		console.log(`Generated pretrust with ${pretrust.length} entries`)

		this.globaltrust = await this.runEigentrust(pretrust, localtrust, strategy.alpha)
		console.log("Generated globaltrust")

		await this.saveGlobaltrust()
	}

	async recommend(limit = 20, id: number): Promise<number[]> {
		if (!this.personalizationStrategy) {
			throw Error('Reommending but no personalization strategy set')
		}

		return this.personalizationStrategy(this.globaltrust, id, limit)
	}

	private runEigentrust = async (pretrust: Pretrust, localtrust: LocalTrust, alpha: number, id?: number): Promise<GlobalTrust> => {
		const convertedPretrust = this.convertPretrustToIndeces(pretrust)
		const convertedLocaltrust = this.convertLocaltrustToIndeces(localtrust)

		const res = await this.requestEigentrust(
			convertedLocaltrust,
			convertedPretrust,
			alpha
		)

		return this.parseGlobaltrust(res)
	}

	async requestEigentrust(localTrust: LocalTrust, pretrust: Pretrust, alpha: number): Promise<GlobalTrust> {
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
				alpha: alpha
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
	async loadFromDB() {
		this.globaltrust = await db('globaltrust')
			.orderBy('v', 'desc')
			.where(this.strategyId)
			.select()

		if (!this.globaltrust.length) {
			throw new Error(`No globaltrust found in DB for strategy id: ${this.strategyId}`)
		}
	}

	private async saveGlobaltrust() {
		const CHUNK_SIZE = 1000
		if (!this.globaltrust.length || this.strategyId) {
			return
		}

		for (let i = 0; i < this.globaltrust.length; i += CHUNK_SIZE) {
			const chunk = this.globaltrust
				.slice(i, i + CHUNK_SIZE)
				.map(g => ({
					strategyId: this.strategyId,
					...g
				}))

			await db('globaltrust')
				.insert(chunk)
				.onConflict(['strategy_id', 'i']).ignore()
		}
	}

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

	private parseGlobaltrust(globaltrust: GlobalTrust): GlobalTrust {
		const parsedGlobaltrust = globaltrust.map(({ i, v }) => {
			return {
				i: this.ids[i],
				v: +v
			}
		})

		return parsedGlobaltrust.sort((a, b) => b.v - a.v)
	}
}
