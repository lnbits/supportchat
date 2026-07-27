const client = window.createLNbitsSupportChatClient({
  extensionId: 'supportchat'
})

const state = {
  context: null,
  conversation: null,
  error: '',
  inbox: null,
  loading: 'initial',
  messages: [],
  mode: '',
  unsubscribeConversation: null,
  visitor: {
    email: '',
    name: '',
    subject: ''
  }
}

const root = document.getElementById('supportchat-public-app')

init()

async function init() {
  render()
  await load()
}

async function load() {
  await withError(async () => {
    state.loading = 'initial'
    render()
    state.context = await client.context()
    const params = state.context.routeParams || {}
    if (params.conversationId) {
      state.mode = 'conversation'
      await loadConversation(params.conversationId)
      return
    }
    if (params.inboxId) {
      const response = await client.getPublicInbox(params.inboxId)
      state.inbox = response.inbox
      const conversationId = await restoreConversationId(params.inboxId)
      if (conversationId) {
        try {
          state.mode = 'conversation'
          await loadConversation(conversationId)
          return
        } catch (_error) {
          await forgetConversation(params.inboxId)
        }
      }
      state.mode = 'start'
      return
    }
    throw new Error('Support page not found.')
  }, 'Could not load support chat.')
  state.loading = ''
  render()
  scrollThreadToBottom()
}

async function loadConversation(conversationId) {
  const response = await client.getPublicConversation(conversationId, {
    rowsPerPage: 200
  })
  state.inbox = response.inbox
  state.conversation = response.conversation
  state.messages = response.messages || []
  state.visitor.name = await restoreVisitorName(conversationId)
  await rememberConversation(state.inbox.id, conversationId)
  await subscribeConversation(conversationId)
}

async function startConversation() {
  if (!state.inbox) return
  const container = document.getElementById('start-box')
  const name = cleanVisitorName(fieldValue(container, 'name'))
  const body = fieldValue(container, 'body').trim()
  if (!body) return
  await withError(async () => {
    state.loading = 'sending'
    render()
    const response = await client.startConversation(state.inbox.id, {
      name,
      email: fieldValue(container, 'email'),
      subject: fieldValue(container, 'subject'),
      body
    })
    const conversationId = response.conversation.id
    state.visitor.name =
      name || cleanVisitorName(response.conversation.visitorName)
    await rememberVisitorName(conversationId)
    await rememberConversation(state.inbox.id, conversationId)
    await client.replaceRoute(
      `/ext/supportchat/c/${encodeURIComponent(conversationId)}`
    )
  }, 'Could not start conversation.')
  state.loading = ''
  render()
}

async function postMessage() {
  if (!state.conversation) return
  const container = document.getElementById('message-box')
  const nameInput = container?.querySelector('[name="name"]')
  const name = cleanVisitorName(nameInput?.value)
  const body = fieldValue(container, 'body').trim()
  if (!name) {
    nameInput?.reportValidity()
    return
  }
  if (!body) return
  state.visitor.name = name
  await withError(async () => {
    state.loading = 'sending'
    render()
    await rememberVisitorName(state.conversation.id)
    const response = await client.postPublicMessage(state.conversation.id, {
      name,
      body
    })
    addMessage(response.message)
  }, 'Could not send message.')
  state.loading = ''
  render()
  scrollThreadToBottom()
}

async function startAnotherConversation() {
  if (!state.inbox) return
  await forgetConversation(state.inbox.id)
  await client.replaceRoute(
    `/ext/supportchat/i/${encodeURIComponent(state.inbox.id)}`
  )
}

async function subscribeConversation(conversationId) {
  if (state.unsubscribeConversation) state.unsubscribeConversation()
  state.unsubscribeConversation = await client.subscribeWebsocket(
    `conversation:${conversationId}`,
    event => {
      if (event.event !== 'websocket.message') return
      const data = event.data || {}
      if (data.conversation) state.conversation = data.conversation
      if (data.message) addMessage(data.message)
      render()
      scrollThreadToBottom()
    }
  )
}

function addMessage(message) {
  if (!message || !message.id) return
  if (state.messages.some(existing => existing.id === message.id)) return
  state.messages.push(message)
  state.messages.sort((left, right) => left.createdAt - right.createdAt)
}

async function withError(fn, fallback) {
  state.error = ''
  try {
    await fn()
  } catch (error) {
    state.error = error instanceof Error ? error.message : fallback
    client.notifyError(state.error).catch(() => {})
  }
}

function render() {
  const accent = state.inbox?.accentColor || '#f2a900'
  root.innerHTML = `
    <main class="sc-shell q-pa-md column items-center" style="--sc-accent:${attr(
      accent
    )}">
      <section class="sc-public-card sc-panel q-pa-md">
        <div class="row items-start justify-between q-gutter-md q-mb-md">
          <div>
            <h1 class="text-h5 text-weight-bold q-my-none">${escapeHtml(
              state.inbox ? state.inbox.name : 'Support Chat'
            )}</h1>
            ${
              state.inbox && state.mode === 'start'
                ? `<p class="sc-muted q-my-xs">${escapeHtml(
                    state.inbox.welcomeMessage
                  )}</p>`
                : ''
            }
            ${
              state.conversation
                ? `<p class="sc-muted q-my-xs">${escapeHtml(
                    state.conversation.subject
                  )} · ${escapeHtml(state.conversation.status)}</p>`
                : state.inbox
                  ? `<p class="sc-presence ${
                      state.inbox.isOnline ? 'sc-presence--online' : ''
                    }">${state.inbox.isOnline ? 'Online' : 'Offline'}</p>`
                : ''
            }
          </div>
          ${
            state.conversation
              ? `<span class="sc-badge">${escapeHtml(
                  state.conversation.status
                )}</span>`
              : ''
          }
        </div>

        ${state.error ? `<div class="q-banner bg-negative text-white q-mb-md q-pa-md">${escapeHtml(state.error)}</div>` : ''}
        ${
          state.inbox && !state.inbox.isOnline
            ? `<div class="q-banner sc-offline-banner q-mb-md q-pa-md">${escapeHtml(
                state.inbox.offlineMessage
              )}</div>`
            : ''
        }
        ${state.loading === 'initial' ? '<div class="sc-empty q-pa-md text-center">Loading...</div>' : ''}
        ${state.mode === 'start' && state.inbox ? renderStartForm() : ''}
        ${
          state.mode === 'conversation' && state.conversation
            ? renderConversation()
            : ''
        }
      </section>
    </main>
  `
  bindEvents()
}

function renderStartForm() {
  return `
    <div id="start-box" class="q-gutter-md">
      <label class="block">
        <span class="text-caption sc-muted">Name</span>
        <input class="sc-input" name="name" maxlength="80" value="${attr(
          state.visitor.name
        )}" />
      </label>
      <label class="block">
        <span class="text-caption sc-muted">Email</span>
        <input class="sc-input" name="email" maxlength="160" value="${attr(
          state.visitor.email
        )}" />
      </label>
      <label class="block">
        <span class="text-caption sc-muted">Subject</span>
        <input class="sc-input" name="subject" maxlength="120" value="${attr(
          state.visitor.subject
        )}" />
      </label>
      <label class="block">
        <span class="text-caption sc-muted">Message</span>
        <textarea class="sc-input" name="body" maxlength="2000"></textarea>
      </label>
      <button class="q-btn bg-primary text-white" type="button" data-action="start-conversation" ${
        state.loading === 'sending' || !state.inbox.isActive ? 'disabled' : ''
      } data-testid="start-conversation">Send</button>
    </div>
  `
}

function renderConversation() {
  return `
    <div class="q-gutter-md">
      <div id="thread" class="sc-thread q-pr-xs">
        ${renderMessages()}
      </div>
      <div id="message-box" class="q-gutter-sm">
        <label class="block">
          <span class="text-caption sc-muted">Name</span>
          <input class="sc-input" name="name" maxlength="80" required value="${attr(
            state.visitor.name
          )}" />
        </label>
        <textarea class="sc-input" name="body" maxlength="2000" placeholder="Message" ${
          state.conversation.status === 'resolved' ? 'disabled' : ''
        }></textarea>
        <button class="q-btn bg-primary text-white" type="button" data-action="send-message" ${
          state.loading === 'sending' || state.conversation.status === 'resolved'
            ? 'disabled'
            : ''
        } data-testid="visitor-send">Send</button>
      </div>
      <button class="q-btn q-btn--flat" type="button" data-action="start-another-conversation">Start another conversation</button>
    </div>
  `
}

function renderMessages() {
  if (!state.messages.length) {
    return '<div class="sc-empty q-pa-md text-center">No messages</div>'
  }
  return state.messages
    .map(
      message => `
        <div class="sc-message ${
          message.senderType === 'agent' ? 'sc-message--agent' : ''
        }">
          <div class="sc-bubble">
            <div class="sc-message-meta">${escapeHtml(
              message.senderName || ''
            )} · ${escapeHtml(formatTime(message.createdAt))}</div>
            <div>${escapeHtml(message.body || '')}</div>
          </div>
        </div>
      `
    )
    .join('')
}

function bindEvents() {
  root.querySelectorAll('[data-action]').forEach(element => {
    element.addEventListener('click', event => {
      const action = event.currentTarget.dataset.action
      if (action === 'start-conversation') startConversation()
      if (action === 'send-message') postMessage()
      if (action === 'start-another-conversation') startAnotherConversation()
    })
  })
  root
    .querySelector('#message-box [name="name"]')
    ?.addEventListener('input', event => {
      state.visitor.name = cleanVisitorName(event.currentTarget.value)
    })
}

function scrollThreadToBottom() {
  const thread = document.getElementById('thread')
  if (thread) thread.scrollTop = thread.scrollHeight
}

function formatTime(timestamp) {
  if (!timestamp) return ''
  return new Date(timestamp * 1000).toLocaleString()
}

function fieldValue(container, name) {
  return String(container?.querySelector(`[name="${name}"]`)?.value || '')
}

function cleanVisitorName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function conversationSessionKey(inboxId) {
  return `conversation:${inboxId}`
}

async function restoreConversationId(inboxId) {
  try {
    const response = await client.getSessionValue(conversationSessionKey(inboxId))
    return String(response?.value || '')
  } catch (_error) {
    return ''
  }
}

async function rememberConversation(inboxId, conversationId) {
  try {
    await client.setSessionValue(
      conversationSessionKey(inboxId),
      conversationId
    )
  } catch (_error) {}
}

async function forgetConversation(inboxId) {
  try {
    await client.setSessionValue(conversationSessionKey(inboxId), '')
  } catch (_error) {}
}

function visitorNameSessionKey(conversationId) {
  return `visitor-name:${conversationId}`
}

async function restoreVisitorName(conversationId) {
  try {
    const response = await client.getSessionValue(
      visitorNameSessionKey(conversationId)
    )
    return cleanVisitorName(response?.value)
  } catch (_error) {
    return ''
  }
}

async function rememberVisitorName(conversationId) {
  if (!state.visitor.name) return
  try {
    await client.setSessionValue(
      visitorNameSessionKey(conversationId),
      state.visitor.name
    )
  } catch (_error) {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]
  })
}

function attr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;')
}
