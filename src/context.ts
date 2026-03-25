export interface TriggerContext {
  issueNumber: number // issue or PR number
  triggerText: string // the specific comment/body that contained the trigger word
  triggerSource: 'issue' | 'pr' // whether the bot was triggered from an issue or a PR
  triggerId: string // ID of the trigger in the database
}
