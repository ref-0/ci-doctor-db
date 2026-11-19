# Breadth research

- Started from well-known projects in each requested language and used web search for Kotlin, Swift, Elixir and large-project CI leads. Removed the inbox repos and the six already scored.
- Batched GitHub GraphQL for canonical repo names, stars, language sizes, push dates and public, archive, mirror and fork status. Kept repos pushed within the prior 14 days.
- Verified substantive GitHub Actions build or test workflows in the public PR run histories, workflow YAML and maintainer docs.
- REST on 19 Nov 2026 UTC used 50 Actions requests and 10 rate-limit requests. Each screened repo got one request with event=pull_request, a created-at cutoff seven days earlier, and per_page=1. The shared balance fell below 1,500 and checks resumed after reset.
- The CSV records total_count as returned, including 2,500 where GitHub reported it. Counts include other workflows with the same event and can include multiple runs per PR.
- The LOC hint rounds GitHub language bytes divided by 30. Expected speed reflects sampled successful workflow durations or workload features, with unknown for inconclusive evidence. Workflow durations cover the named workflows.
- Examples omitted include Rails (main test suite on Buildkite), WordPress Develop (SVN mirror) and Kotlin coroutines and serialization (zero qualifying REST runs).
- No GitHub Search API calls, clones or scorer runs.
