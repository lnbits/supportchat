import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function publicPage({sessionName = ''} = {}) {
  const source = await readFile(
    new URL('../../static/public.js', import.meta.url),
    'utf8'
  )
  const postedMessages = []
  const routes = []
  const sessionWrites = []
  const fields = {
    'message-box': {name: '', body: ''},
    'start-box': {name: '', email: '', subject: '', body: ''}
  }

  const container = id => ({
    querySelector(selector) {
      const name = selector.match(/name="([^"]+)"/)?.[1]
      if (!name) return null
      return {
        get value() {
          return fields[id][name] || ''
        },
        set value(value) {
          fields[id][name] = value
        },
        addEventListener() {},
        reportValidity() {}
      }
    }
  })
  const root = {
    innerHTML: '',
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    }
  }
  const client = {
    context: () => Promise.resolve({routeParams: {}}),
    getPublicConversation: () =>
      Promise.resolve({
        inbox: {id: 'inbox-1', name: 'Support'},
        conversation: {
          id: 'conversation-1',
          visitorName: 'Original visitor',
          subject: 'Help',
          status: 'open'
        },
        messages: []
      }),
    getSessionValue: () => Promise.resolve({value: sessionName}),
    setSessionValue: (key, value) => {
      sessionWrites.push({key, value})
      return Promise.resolve({ok: true})
    },
    startConversation: (_inboxId, payload) =>
      Promise.resolve({
        conversation: {
          id: 'conversation-1',
          visitorName: payload.name || 'Guest'
        }
      }),
    postPublicMessage: (_conversationId, payload) => {
      postedMessages.push(JSON.parse(JSON.stringify(payload)))
      return Promise.resolve({
        message: {
          id: `message-${postedMessages.length}`,
          senderName: payload.name,
          body: payload.body,
          createdAt: 1
        }
      })
    },
    replaceRoute: path => {
      routes.push(path)
      return Promise.resolve()
    },
    subscribeWebsocket: () => Promise.resolve(() => {}),
    notifyError: () => Promise.resolve()
  }
  const document = {
    getElementById(id) {
      if (id === 'supportchat-public-app') return root
      if (id === 'thread') return null
      if (fields[id]) return container(id)
      return null
    }
  }
  const window = {
    createLNbitsSupportChatClient: () => client
  }
  const context = vm.createContext({
    console,
    document,
    window,
    URLSearchParams,
    setTimeout,
    clearTimeout
  })
  vm.runInContext(source, context)
  await new Promise(resolve => setImmediate(resolve))

  return {
    context,
    fields,
    postedMessages,
    routes,
    sessionWrites
  }
}

test('the browser SDK exposes extension-scoped session storage', async () => {
  const source = await readFile(
    new URL('../../static/lnbits-extension-sdk.js', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /getSessionValue\(key\)[\s\S]+action: 'storage\.session\.get'/
  )
  assert.match(
    source,
    /setSessionValue\(key, value\)[\s\S]+action: 'storage\.session\.set'/
  )
})

test('an existing conversation does not inherit its original visitor name', async () => {
  const page = await publicPage()

  await vm.runInContext('loadConversation("conversation-1")', page.context)

  assert.equal(vm.runInContext('state.visitor.name', page.context), '')
})

test('each browser posts and remembers its own message name', async () => {
  const alice = await publicPage({sessionName: 'Alice'})
  await vm.runInContext('loadConversation("conversation-1")', alice.context)
  alice.fields['message-box'] = {name: 'Alice', body: 'From Alice'}
  await vm.runInContext('postMessage()', alice.context)

  const bob = await publicPage()
  await vm.runInContext('loadConversation("conversation-1")', bob.context)
  bob.fields['message-box'] = {name: 'Bob', body: 'From Bob'}
  await vm.runInContext('postMessage()', bob.context)

  assert.deepEqual(alice.postedMessages, [
    {name: 'Alice', body: 'From Alice'}
  ])
  assert.deepEqual(bob.postedMessages, [{name: 'Bob', body: 'From Bob'}])
  assert.deepEqual(alice.sessionWrites, [
    {key: 'conversation:inbox-1', value: 'conversation-1'},
    {key: 'visitor-name:conversation-1', value: 'Alice'}
  ])
  assert.deepEqual(bob.sessionWrites, [
    {key: 'conversation:inbox-1', value: 'conversation-1'},
    {key: 'visitor-name:conversation-1', value: 'Bob'}
  ])
})

test('the conversation creator keeps their name after the route change', async () => {
  const page = await publicPage()
  vm.runInContext(
    "state.inbox = {id: 'inbox-1', isActive: true}; state.mode = 'start'",
    page.context
  )
  page.fields['start-box'] = {
    name: 'Alice',
    email: 'alice@example.com',
    subject: 'Help',
    body: 'Hello'
  }

  await vm.runInContext('startConversation()', page.context)

  assert.deepEqual(page.sessionWrites, [
    {key: 'visitor-name:conversation-1', value: 'Alice'},
    {key: 'conversation:inbox-1', value: 'conversation-1'}
  ])
  assert.deepEqual(page.routes, ['/ext/supportchat/c/conversation-1'])
})
