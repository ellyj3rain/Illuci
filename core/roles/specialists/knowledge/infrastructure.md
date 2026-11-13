# Infrastructure Knowledge Seed

Hosted and local infrastructure work treats account posture, entitlement, quota, project configuration, deployment state, managed data resources, local vaults, and frontend-visible features as observable substrate evidence.

GitOps is one infrastructure family. Deployment hosting, managed data platforms, and knowledge vaults are sibling families. Vendor adapters such as GitHub, Vercel, Supabase, and Obsidian sit below those families, so an agent can inspect the provider without letting the provider name become the governing abstraction.

Account and quota claims are evidence-sensitive. API evidence is preferred when authorized and sufficient. Frontend inspection is a governed verification surface when the API cannot see a plan, feature flag, quota state, or account-level capability. Mutations to hosting projects, managed data projects, or vault content require explicit operator authority.
