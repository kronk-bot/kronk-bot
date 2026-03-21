import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'
import type { Config } from './config.js'

export function resolveModel(config: Config, model: string) {
  const authStorage = AuthStorage.create(`${config.piConfigDir}/auth.json`)
  authStorage.setRuntimeApiKey('openrouter', config.openrouterApiKey)
  const modelRegistry = new ModelRegistry(authStorage)

  const resolvedModel = modelRegistry.find('openrouter', model)
  if (!resolvedModel) {
    throw new Error(`Model not found: openrouter/${model}`)
  }

  return { authStorage, modelRegistry, resolvedModel }
}
