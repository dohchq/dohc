export class MarkdownNestingRefusal extends Error {
  constructor(readonly limit: 'depth' | 'lexing') {
    super('Markdown is not representable by the live document contract')
    this.name = 'MarkdownNestingRefusal'
  }
}
