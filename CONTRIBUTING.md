# Contributing to Illuci

Start with the behavior you want to improve and the part of the engine that owns it. Follow the existing execution path before adding another abstraction. A useful contribution makes the result clearer, more capable or more dependable without losing the task's scope or the permissions around its effects.

Keep one coherent change together. Identify its affected callers, data and configuration, preserve relevant source history, and explain what the new result demonstrates. Use focused checks for changed boundaries and retain evidence that still applies. Provider fixtures should be synthetic; live credentials, personal transcripts and machine-specific state do not belong in a contribution.

Do not claim a model-quality improvement from a routing change or successful unit test. Show the observed behavior and its limits. Report uncertain external outcomes without automatically retrying them.

For a policy change, distinguish the engine mechanism from the Ground Zero provision it adopts. Propose framework refinements in Ground Zero and engine changes here, with explicit reciprocal references. This repository owns Illuci's public scope and release; neither project silently governs the other's working tree.

Public commits, pull requests and releases identify the human contributor and the developed system. Keep provider/model coauthor trailers, generated-by footers and imposed vendor labels out of that metadata. Retain accurate functional compatibility identifiers, required legal notices and relevant technical provenance.
