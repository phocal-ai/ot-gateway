/**
 * The docs' diagrams by name. A ```mermaid block in `docs/*.md` that starts with `%% site: <name>` is drawn by the
 * component of that name here (src/content/diagrams.ts); GitHub draws the block itself.
 */
import type * as React from "react"
import { InputsOverview, InputsRow } from "./inputs.tsx"
import { StatusPageTabs } from "./status-page.tsx"
import { HeadlessFailures, HeadlessMap, HeadlessPath } from "./headless.tsx"

export const diagrams: Readonly<Record<string, React.ComponentType>> = {
  "inputs-overview": InputsOverview,
  "inputs-row": InputsRow,
  "headless-path": HeadlessPath,
  "headless-map": HeadlessMap,
  "headless-failures": HeadlessFailures,
  "status-page-tabs": StatusPageTabs
}

export const Diagram = ({ name }: { readonly name: string }) => {
  const Drawing = diagrams[name]
  // test/docs.test.ts fails for a name without a component, so this is never reached on a built page.
  return Drawing === undefined ? null : <Drawing />
}
