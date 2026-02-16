// Binding which spawns agents.
export interface AgentSpawnerBinding<Props = {}> {
  // Spawn an agent to perform a task. Returns as soon as the agent has been successfully started
  // (does not wait for it to complete).
  //
  // `title` is the title of the new agent chat which will appear in the gadget's chat history.
  //
  // `prompt` tells the agent what to do. This effectively creates a new AI agent chat (which the
  // user will be able to see in the conversation history) beginning with this prompt as the first
  // message.
  //
  // `props` is an object which will be made available to the agent. When the agent uses its
  // `executeCode` tool to run arbitrary JavaScript code, the code will be able to access this
  // object via `ctx.props`. `props` must be serializable according to the usual rules for
  // `ctx.props` serialization: it can contain any plain data type normally supported by Workers
  // RPC, as well as service binding stubs.
  //
  // Keep in mind that a worker can reference its own entrypoints as service bindings via
  // `ctx.exports` (or `this.ctx.exports` inside a `WorkerEntrypoint` or `DurableObject`
  // implementation). `ctx.exports` contains a loopback service binding corresponding to every
  // top-level `WorkerEntrypoint` class exported by a worker. You can specialize this service
  // binding with `props` that get passed back to it.
  //
  // For exmaple, imagine a spawner binding called `AGENT_SPAWNER` declared as
  // `AgentSpawnerBinding<SpawnerProps>`, with these additional types:
  //
  //   type SpawnerProps = {
  //     greeter: Service<Greeter>
  //   }
  //
  //   // A service that creates friendly greetings for people, based on their name.
  //   interface Greeter extends WorkerEntrypoint {
  //     greet(name: string): Promise<string>;
  //   }
  //
  // You could invoke the agent spawner providing it a `Greeter` callback like:
  //
  //   import { WorkerEntrypoint } from "cloudflare:workers";
  //
  //   // Define a hook entrypoint whose run() method spawns an agent.
  //   export class AgentHook extends WorkerEntrypoint {
  //     async run() {
  //       let howdyGreeter = this.ctx.exports.Greeter({props: {greeting: "Howdy"}});
  //       let prompt = "Please use the provided greeter, props.greeter, to greet the user.";
  //       env.AGENT_SPAWNER.spawn(prompt, {greeter: howdyGreeter});
  //     }
  //   }
  //
  //   // Entrypoint that generates greetings. Can be configured with a custom greeting.
  //   export class Greeter extends WorkerEntrypoint {
  //     greet(name) {
  //       let greeting = this.ctx.props.greeting || "Hello";
  //       return `${greeting}, ${name}!`;
  //     }
  //   }
  spawn(title: string, prompt: string, props: Props): Promise<void>;
}
