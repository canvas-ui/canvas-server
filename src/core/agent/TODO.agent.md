# Thousand loops

- Internal loop NNs, outputs into global context
  - Small NN to eval input stream of data 
    - v internal state
    - v full NN
    - v full NN w context
  - ST world prediction
- Dynamic focus, allow deep introspection
  - 
  - silencing parts of global context

What still needs doing (for the new session):

Web UI wiring — src/ui/web/ still references chatStream, memory, getMCPTools. Needs updating to use prompt/stream endpoints.
