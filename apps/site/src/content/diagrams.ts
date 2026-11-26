/**
 * Diagrams in the docs. The Markdown in `docs/` holds each one as a ```mermaid block, which GitHub draws and an
 * agent reads. A block whose first line names a site diagram,
 *
 *     %% site: headless-path
 *
 * (a Mermaid comment, so GitHub ignores it) is drawn here by the React component of that name
 * (`src/components/docs/diagrams.tsx`) instead, in the site's own design. The page's Markdown twin keeps the block.
 */
import { replaceSource } from "fumadocs-core/mdx-plugins/stringifier"

/** The Markdown tree's types, as Fumadocs has them: the site depends on neither `mdast` nor `vfile` itself. */
type File = Parameters<typeof replaceSource>[0]
type Node = Parameters<typeof replaceSource>[1]
type Parent = Extract<Node, { children: ReadonlyArray<unknown> }>

/** The site diagram a Mermaid block names on its first line, if it names one. */
export const siteDiagram = (mermaid: string): string | undefined =>
  /^%% site: ([a-z0-9-]+)\s*$/.exec(mermaid.split("\n")[0] ?? "")?.[1]

const isParent = (node: Node): node is Parent => "children" in node

/** Replaces each Mermaid block that names a site diagram with `<Diagram name="…" />`. */
export const remarkSiteDiagram = () => (tree: Node, file: File) => {
  const visit = (parent: Parent) => {
    const children: Array<Node> = parent.children
    children.forEach((node, index) => {
      if (node.type === "code" && node.lang === "mermaid") {
        const name = siteDiagram(node.value)
        if (name === undefined) return
        // The Markdown of the page (its `.md` URL, llms-full.txt) keeps the block as it was written.
        replaceSource(file, node, (s) => s.stringify(node))
        children[index] = {
          type: "mdxJsxFlowElement",
          name: "Diagram",
          attributes: [{ type: "mdxJsxAttribute", name: "name", value: name }],
          children: []
        }
      } else if (isParent(node)) visit(node)
    })
  }
  if (isParent(tree)) visit(tree)
}
