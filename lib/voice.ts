/* Spoken turn prompts through the browser's own speech synthesis, in a Russian voice when the phone
   has one. Nothing is sent anywhere: the phone speaks the text itself. */
let voice: SpeechSynthesisVoice | null = null

export const speechAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Say a prompt at once, cutting off whatever was still being said. */
export function say(text: string) {
  if (!speechAvailable()) return
  const synth = window.speechSynthesis
  // Voices can arrive after the page loads, so keep looking until a Russian one turns up.
  voice ??= synth.getVoices().find(candidate => candidate.lang?.toLowerCase().startsWith('ru')) ?? null
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'ru-RU'
  if (voice) utterance.voice = voice
  synth.speak(utterance)
}

export function hush() {
  if (speechAvailable()) window.speechSynthesis.cancel()
}
