import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_team_plans (
      thread_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
});
