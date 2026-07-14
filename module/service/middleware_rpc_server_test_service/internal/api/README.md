# API Handlers

Keep external service/topic handlers thin. They adapt protocol payloads and call
`internal/service`; transport names and middleware choices stay in
`config/config.yaml`.
