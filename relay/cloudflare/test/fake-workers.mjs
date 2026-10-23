// Stand-in for the 'cloudflare:workers' module when running the adapter under plain Node (tests only).
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
