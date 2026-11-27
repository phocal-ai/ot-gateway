/**
 * The prompts of "Explore with an AI agent" on each docs page: copied into any agent that can read a web page,
 * they point it at the page's Markdown twin (the page's URL plus `.md`, see vercel.json) so the reader can ask
 * their own questions there.
 */

/** A tab of the prompt block: its label and the prompt it copies. */
export interface ExplorePrompt {
  readonly label: string
  readonly prompt: string
}

/** The prompts for the docs page titled `title`, whose Markdown is at `markdownUrl` (absolute). */
export const explorePrompts = (title: string, markdownUrl: string): ReadonlyArray<ExplorePrompt> => {
  /** In typographic quotes, so a title with a straight quote of its own still reads as one. */
  const quoted = `\u201c${title}\u201d`
  return [
    {
      label: "TL;DR",
      prompt: `Read ${markdownUrl}. In under 200 words, explain what the ${quoted} page of the OT Gateway docs says and list its key points, one line each. OT Gateway reads Modbus TCP and BACnet/IP devices in buildings and industrial sites and sends their values as MQTT. Use only what the page says, and say so when it doesn't cover something.`
    },
    {
      label: "Your site",
      prompt: `Read ${markdownUrl}, the ${quoted} page of the OT Gateway docs. Then ask me, a few questions at a time, about my building or site: which devices, which protocols (Modbus TCP, BACnet/IP), where the data should go and what runs the gateway. Explain what this page means for my setup in under 200 words and what I would do next. Use only what the page says, and say so when it doesn't cover something.`
    }
  ]
}

/** The Markdown twin of the page at `path` (`/docs` or `/docs/<slug>`) on the site at `origin`. */
export const markdownTwin = (origin: string, path: string): string => `${origin}${path}.md`
