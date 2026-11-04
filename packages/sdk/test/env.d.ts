declare global {
  namespace Cloudflare {
    interface Env {
      DB: DurableObjectNamespace;
    }
  }
}
export {};
