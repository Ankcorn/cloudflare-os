// This file defines the schema of the Overseer's storage.
//
// Each type here defines the schema a "collection", in the sense of MongoDB. Of course, since
// the Overseer is a Durable Object, its actual storage is SQLite, and we will need to model
// "collections" in terms of SQL tables.

// TODO:
// - Gatekeepers
// - Code
//   - Currently deployed
//   - In-progress changes
//   - Edit history
// - Agent state
//   - Chat history
//   - "Memory" of important info
// - Actions
//   - Approval queue
//   - Log of past actions
