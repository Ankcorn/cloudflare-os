import { MarketoUserVerifier } from "../src/marketo";

export { default } from "../src/marketo";
export * from "../src/marketo";

/** Test-visible entrypoint exercising the production verifier implementation. */
export class TestMarketoUserVerifier extends MarketoUserVerifier {}
