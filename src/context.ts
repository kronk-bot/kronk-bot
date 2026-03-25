export interface TriggerContext {
  issueNumber: number
  triggerText: string // the specific comment/body that contained @kronk-bot
  triggerSource: 'issue' | 'pr' // whether the bot was triggered from an issue or a PR comment
  triggerId: string // ID of the trigger in the database
}
