const plain = (text) => text.toLocaleLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’']/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const SOCIAL = {
  greeting: /^(?:(?:hi|hello|hey|howdy|good morning|good afternoon|good evening|bonjour|bonsoir|salut|coucou)(?: there| tout le monde)?)(?: (?:hi|hello|hey|bonjour|bonsoir|salut))?$/,
  thanks: /^(?:(?:ok|okay|alright|all right|d accord|ca marche|compris) )?(?:thanks?|thank you|thanks a lot|thank you very much|merci|merci beaucoup|merci bien|je vous remercie|je te remercie)(?: (?:thanks?|thank you|merci|merci beaucoup))?$/,
  acknowledgement: /^(?:ok|okay|alright|all right|got it|understood|sure|great|d accord|ca marche|compris|entendu|bien compris|tres bien)(?: (?:ok|okay|d accord|compris))?$/,
  farewell: /^(?:(?:ok|okay|alright|d accord) )?(?:bye|goodbye|good bye|see you|see you soon|take care|good night|good evening|au revoir|a bientot|bonne nuit|bonne soiree|bonne journee|a demain)(?: (?:bye|goodbye|au revoir))?$/,
};

export function socialKind(text) {
  const normalized = plain(text);
  for (const [kind, pattern] of Object.entries(SOCIAL)) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
}

const REPLIES = {
  en: {
    greeting: 'Hello! How can I help?',
    thanks: 'You’re welcome!',
    acknowledgement: 'Of course.',
    farewell: 'Goodbye!',
  },
  fr: {
    greeting: 'Bonjour ! Comment puis-je vous aider ?',
    thanks: 'Je vous en prie !',
    acknowledgement: 'Bien sûr.',
    farewell: 'Au revoir !',
  },
};

export function socialReply(kind, language) {
  return REPLIES[language]?.[kind] ?? REPLIES.en[kind];
}
