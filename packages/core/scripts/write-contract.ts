/**
 * Writes the MQTT contract's JSON Schemas to `docs/mqtt-contract/v<major>/`, from `src/Contract.ts`:
 *
 *   pnpm --filter @ot-gateway/core contract:write
 *
 * `test/Contract.test.ts` fails when the files and the schemas differ.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { contractJsonSchemas, contractSchemaDirectory } from "../src/Contract.ts"

const directory = join(import.meta.dirname, "..", "..", "..", contractSchemaDirectory)
mkdirSync(directory, { recursive: true })
for (const [message, schema] of Object.entries(contractJsonSchemas())) {
  writeFileSync(join(directory, `${message}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`)
}
process.stdout.write(`wrote ${directory}\n`)
