import { expect, it } from 'vitest';
import { githubStars } from '../github-stars';

const fetchRepository = (body: unknown) => (async () => Response.json(body)) as typeof fetch;

it('shortens large star counts', async () => {
  expect(await githubStars(fetchRepository({ stargazers_count: 2 }))).toBe('2');
  expect(await githubStars(fetchRepository({ stargazers_count: 1234 }))).toBe('1.2K');
  expect(await githubStars(fetchRepository({ stargazers_count: 56789 }))).toBe('56.8K');
});

it('reports no count when GitHub is unreachable, limits the request, or answers malformed', async () => {
  expect(await githubStars((async () => { throw new Error('offline'); }) as typeof fetch)).toBeNull();
  expect(await githubStars((async () => new Response(null, { status: 403 })) as typeof fetch)).toBeNull();
  expect(await githubStars(fetchRepository({ message: 'rate limited' }))).toBeNull();
  expect(await githubStars(fetchRepository(null))).toBeNull();
});
