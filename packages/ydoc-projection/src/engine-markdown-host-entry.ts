import {runEngineMarkdownHost} from './engine-markdown-host.js'
export {createEngineMarkdownReader} from './engine-markdown-reader.js'
if (process.argv[1] === __filename) void runEngineMarkdownHost()
