import pg from "pg";

/**
 * Seeds a contract database with SQL only, through the tables' documented columns: the contract
 * suite reaches the core through its public API, so it does not use the core's own seed helpers.
 */
export async function seedRepository(
  databaseUrl: string,
  repo: { readonly githubId: number; readonly owner: string; readonly name: string },
  docs: readonly { readonly path: string; readonly title: string; readonly body: string }[],
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO repos (github_id, owner, name, default_branch, visibility, html_url, sync_status, last_synced_at)
       VALUES ($1, $2, $3, 'main', 'public', $4, 'ok', now()) RETURNING id`,
      [repo.githubId, repo.owner, repo.name, `https://github.com/${repo.owner}/${repo.name}`],
    );
    const repoId = inserted.rows[0]?.id;
    for (const doc of docs) {
      await client.query(
        `INSERT INTO documents (repo_id, path, blob_sha, size_bytes, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [repoId, doc.path, `sha-${doc.path}`, doc.body.length, doc.title, doc.body],
      );
    }
  } finally {
    await client.end();
  }
}
