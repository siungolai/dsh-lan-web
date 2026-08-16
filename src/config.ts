/**
 * dsh-lan-web — user-editable configuration (settings namespace `dsh-lan-web`).
 *
 * Security-sensitive data (password hash, sessions, epoch) intentionally does
 * NOT live here — it is kept in the plugin's private data file
 * (`$DSH_HOME/dsh-lan-web.json`, mode 0600, atomic writes).
 */
import z from 'schemastery'

export const lanWebConfigSchema = z.object({
  /** Sliding session lifetime: days without activity before logout. */
  sessionDays: z.number().min(1).max(365).default(30),
  /** Reserved (M4): HTTPS certificate path. Not implemented in v0.1. */
  httpsCert: z.string().default(''),
  /** Reserved (M4): HTTPS private key path. Not implemented in v0.1. */
  httpsKey: z.string().default(''),
})

export interface LanWebConfig {
  sessionDays: number
  httpsCert: string
  httpsKey: string
}

export const DEFAULT_LAN_WEB_CONFIG: LanWebConfig = {
  sessionDays: 30,
  httpsCert: '',
  httpsKey: '',
}
