import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page"
import defaultMdxComponents from "fumadocs-ui/mdx"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { pageMarkdownUrl, source } from "@/lib/source.ts"

interface Props {
  readonly params: Promise<{ readonly slug?: Array<string> }>
}

const Page = async ({ params }: Props) => {
  const { slug } = await params
  const page = source.getPage(slug)
  if (page === undefined) notFound()
  const Body = page.data.body
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="text-fd-muted-foreground flex gap-4 border-b pb-6 text-sm">
        <a className="hover:text-fd-foreground" href={page.data.source}>
          Source on GitHub
        </a>
        <a className="hover:text-fd-foreground" href={pageMarkdownUrl(page)}>
          Markdown
        </a>
      </div>
      <DocsBody>
        <Body components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  )
}

export default Page

export const generateStaticParams = () => source.generateParams()

export const generateMetadata = async ({ params }: Props): Promise<Metadata> => {
  const { slug } = await params
  const page = source.getPage(slug)
  if (page === undefined) notFound()
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url, types: { "text/markdown": pageMarkdownUrl(page) } }
  }
}
