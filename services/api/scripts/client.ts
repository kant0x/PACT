const baseUrl = process.env.PACT_API_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;

export async function post(path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
  } catch {
    throw new Error(`PACT API is not reachable at ${baseUrl}. Start it with "npm run dev -w @pact/api".`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result;
}
