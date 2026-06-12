// Mock GitHub integration: stands in for OAuth + a repo picker. The real
// product would swap this for a GitHub App installation flow.

export interface GithubRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string;
  language: string;
  private: boolean;
}

const SAMPLE_REPOS: GithubRepo[] = [
  {
    id: 1,
    full_name: "acme/storefront",
    html_url: "https://github.com/acme/storefront",
    description: "Next.js storefront with a Fastify API and Postgres.",
    language: "TypeScript",
    private: false,
  },
  {
    id: 2,
    full_name: "acme/billing-service",
    html_url: "https://github.com/acme/billing-service",
    description: "Python FastAPI billing service with Redis workers.",
    language: "Python",
    private: true,
  },
  {
    id: 3,
    full_name: "acme/realtime-chat",
    html_url: "https://github.com/acme/realtime-chat",
    description: "Go websocket backend + React client + RabbitMQ.",
    language: "Go",
    private: false,
  },
];

export function listRepos(): Promise<GithubRepo[]> {
  return new Promise((resolve) => setTimeout(() => resolve(SAMPLE_REPOS), 400));
}

const GITHUB_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+/i;

export function isValidRepoUrl(url: string): boolean {
  return GITHUB_URL.test(url.trim());
}
