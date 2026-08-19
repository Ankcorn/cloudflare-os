# Integration tests and agent evaluation

This document gives our approach to tests above the unit level. It covers why we do this work, the
system we want, the architecture, and the gates.

I wrote it in Simplified Technical English (ASD-STE100).

## Why we do this

An AI agent writes the applications on this platform. The agent writes the code, and the code runs in
a sandbox. Unit tests show that our own modules behave correctly. They cannot show that the agent
delivers an application that works.

Two questions need a different kind of test:

1. Does the platform work when we run all of its parts together?
2. Does the agent deliver a working application?

The first question needs integration tests. The second question needs evaluations. We keep the two
apart, because one is deterministic and the other is not.

## The system we want

These are the properties of the system we want. Each one is a rule we apply now.

- Each test measures a result. No test measures the method that produced the result.
- Each deterministic test runs on every commit. It costs no money and it gives the same answer twice.
- Each test that needs a model runs on a schedule. It never blocks a merge by accident.
- Each failure names its cause. A reader must not have to guess.
- We do not count a failure against the agent if we cannot attribute the failure to the agent.
- The suite shows the limits of the agent. It does not hide them.

The last two properties matter most. A suite that blames the agent for a rate limit is worse than no
suite, because it reports a regression that did not happen.

## Architecture

Four suites test more than one module at a time. They are not interchangeable.

| Suite | Runtime | Reaches | We use it for |
|---|---|---|---|
| `workshop-backend/__integration__` | in-process workerd | Worker and Durable Object internals | resilience of the backend |
| `packages/integration-tests` | out-of-process workerd | the public RPC API only | Gadget behaviour, gatekeeper flows |
| a consumer repo suite | out-of-process workerd | one real gatekeeper | an expired credential, end to end |
| `packages/workshop-evals` | out-of-process workerd, and a live model | the agent, then its Gadget | capability of the agent |

The runtime decides what each suite can reach. This is the most important column in the table.

An in-process suite runs inside workerd. Therefore it can use the `cloudflare:test` helpers. It can
stop one Durable Object, and it can test a native RPC boundary. No other suite can do this.

An out-of-process suite drives workerd from Node. Therefore it gets a real WebSocket connection,
several Workers with bindings to each other, and a Worker Loader that runs Gadget code. It reaches the
platform only through the API that a browser has.

The two runtimes need different methods for the same test. To restart a server in-process, stop the
object directly. To restart a server out-of-process, apply an empty code update. The platform does
the same thing on every code change. Neither method works in the other runtime.

### Layers

`packages/integration-tests` owns the tools. It holds the harness, the RPC client, and the driver that
runs an agent session. `packages/workshop-evals` adds the model, and nothing below it. A consumer
repository uses the same tools against a real gatekeeper.

Put a test as low in this stack as it can go. A test that needs no model belongs in an integration
suite, where it runs on every commit.

## What we measure

We score the result, and we never score the method. A task gives the agent a prompt. The agent builds
a Gadget. The task then calls the Gadget's own RPC and checks what it answers.

One example shows why this rule matters. A task asks for an appointment desk that never sells more
places than it has. The agent passed it with a method we did not expect: it made the check and the
write one SQL sequence, and it added a database trigger as a second defence. A check for a specific
technique would have failed a correct answer.

We record the trajectory as well: the tool calls, the errors, the turns, the tokens, the time, and the
cost. These numbers explain a result. They never decide it. An agent that recovered from a failed tool
call still delivered the application.

## Gates

We have two gates, and they are deliberately different.

**Gate 1: every commit.** `pnpm build`, `pnpm test`, and `pnpm lint` run on every pull request. They
are deterministic and they cost nothing. This gate blocks a merge. All four integration suites that
need no model run here.

**Gate 2: on a schedule.** The evaluations run each night, on demand, and on a pull request that
carries the `run-evals` label. This gate does not block a merge unless somebody asks for it. It costs
real inference, and one trial takes several minutes.

Inside Gate 2, each task has one of two states:

- A **required** task blocks the evaluation job when it fails. A failure is a regression.
- A **frontier** task records its score and never fails the job. It measures a limit of the agent.

We set this state from measurement, and never from an opinion. A new task starts as frontier, because
we know nothing about it yet. We promote it after a baseline shows that it passes. We return it to
frontier if it stops passing, and we write the observed failure onto the task.

### Trials that we do not count

A trial is invalid when we cannot attribute its result to the agent. We exclude an invalid trial from
every rate, and we count it separately.

A trial is invalid in these cases:

- The model provider refused the request, or it cut the response.
- The turn ended with an error, and the trial also failed.
- The harness could not start.

A trial that passed after a transient error is still valid. The agent delivered the application, so we
score it.

Watch the **Invalid** column in the summary. A high number means that the run measured less than it
appears to measure.

## Statistics

One trial proves very little, because the agent is not deterministic. Each task runs several times.
The summary reports the pass rate, a Wilson 95% interval, the mean score, and the spread of tokens,
time, and cost.

The interval is wide at three trials. This is honest, and it is not a defect. Raise the number of
trials before you compare two models.

## Durability

The server of a Gadget stops and starts often. The platform restarts it on every code change, and not
only after a fault. Therefore an application must hold its state in storage, and not in memory.

We test this in two places. `packages/integration-tests` pins the behaviour of the platform with a
Gadget that we wrote by hand. `packages/workshop-evals` asks whether the application that the agent
built survives the same treatment.

A restart makes every open stub invalid. This is inconvenient, but it is also useful: it is the only
honest proof that a restart occurred. A test that trusts a restart it cannot see can pass for no
reason.

## Current state

We measured each task once against one model. This is enough to set the state of a task. It is not
enough to compare two models.

- Five tasks pass. We give them the required state.
- One task passes one trial in three. It keeps the frontier state, and we recorded the two causes.
- Two tasks have no measurement yet. They keep the frontier state.

## Next steps

1. Run a baseline with ten trials and two models. Then set each task state again.
2. Add tasks for the connectors. This needs a fixture gatekeeper with a real session API.
3. Decide whether we want external benchmarks. This needs a shell tool and a second prompt, so it
   measures a different agent from the one we ship.

## More information

- [`integration-testing.md`](integration-testing.md) explains the design of the tools, and the traps.
- [`../packages/workshop-evals/README.md`](../packages/workshop-evals/README.md) explains how to write
  a task and how to read a result.
