import { answerChatParse, type ChatParseRequest } from "./chatMarkdownParse";

self.onmessage = ({ data }: MessageEvent<ChatParseRequest>) => {
  self.postMessage(answerChatParse(data));
};
