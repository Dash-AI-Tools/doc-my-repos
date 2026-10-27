/** The server's `{error}` text for a failed admin request, or a generic one. */
export async function failureText(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {}
  return `Request failed (${response.status})`;
}
