;(function () {
  const script = document.currentScript
  if (!script) return

  const inboxId = String(script.dataset.inbox || '').trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inboxId)) {
    console.error('[supportchat widget] Missing or invalid data-inbox value.')
    return
  }

  const sourceUrl = new URL(script.src, window.location.href)
  if (sourceUrl.origin !== window.location.origin) {
    console.error(
      '[supportchat widget] The widget currently requires the host page and LNbits to share an origin.'
    )
    return
  }

  const accent = /^#[0-9a-f]{6}$/i.test(script.dataset.color || '')
    ? script.dataset.color
    : '#f2a900'
  const label = String(script.dataset.label || 'Chat with support').slice(0, 40)
  const position = script.dataset.position === 'left' ? 'left' : 'right'
  const panel = document.createElement('div')
  const button = document.createElement('button')
  const iframe = document.createElement('iframe')

  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', label)
  Object.assign(panel.style, {
    position: 'fixed',
    bottom: '84px',
    [position]: '20px',
    width: 'min(420px, calc(100vw - 24px))',
    height: 'min(680px, calc(100vh - 110px))',
    borderRadius: '14px',
    overflow: 'hidden',
    boxShadow: '0 18px 60px rgba(0, 0, 0, .35)',
    zIndex: '2147483646'
  })

  iframe.src = `${sourceUrl.origin}/ext/supportchat/i/${encodeURIComponent(
    inboxId
  )}?embed=1`
  iframe.title = label
  iframe.style.cssText = 'width:100%;height:100%;border:0;background:#121212'
  panel.appendChild(iframe)

  button.type = 'button'
  button.textContent = label
  button.setAttribute('aria-expanded', 'false')
  Object.assign(button.style, {
    position: 'fixed',
    bottom: '20px',
    [position]: '20px',
    minHeight: '48px',
    padding: '0 18px',
    border: '0',
    borderRadius: '999px',
    background: accent,
    color: '#111',
    cursor: 'pointer',
    font: '600 15px system-ui, sans-serif',
    boxShadow: '0 8px 28px rgba(0, 0, 0, .3)',
    zIndex: '2147483647'
  })

  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    button.setAttribute('aria-expanded', String(!panel.hidden))
    button.textContent = panel.hidden ? label : 'Close support'
  })

  document.body.append(panel, button)
})()
