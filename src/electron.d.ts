export {}

declare global {
  interface Window {
    debate?: {
      getRuntimeConfig: () => Promise<{ dialogueModel: string; judgeModel: string }>
    }
  }
}