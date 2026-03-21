export interface TriggerContext {
  issueNumber: number
  title: string
  body: string
  comments: string // all issue comments formatted as "[user]: body"
  triggerText: string // the specific comment/body that contained @kronk-bot
}
