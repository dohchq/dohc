// Keep this message equal to moment_apply::pending::BINDING_CHANGED.
export const SETTLEMENT_BINDING_CHANGED =
  "This file's name, location, or sharing changed before this save arrived. Open the file to continue.";

// Keep this message equal to settlement_publication::REFUSAL_MESSAGE. It can
// cover several saves of one file.
export const SETTLEMENT_ATTRIBUTION_REFUSED =
  "dohc could not verify who changed this file. The file will share without author names.";

// Keep this message equal to relay::SHARE_CHAT_REFUSED: a chat message, comment
// or reaction a joined workspace sent that the server refused.
export const SHARE_CHAT_REFUSED =
  "The server refused this chat message. dohc set it aside and kept sending later ones.";
