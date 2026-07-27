import {storage, system, websocket} from './lnbits-sdk.js'

const INBOXES_TABLE = 'inboxes'
const CONVERSATIONS_TABLE = 'conversations'
const MESSAGES_TABLE = 'messages'
const INTERNAL_NOTES_TABLE = 'internal_notes'
const CANNED_REPLIES_TABLE = 'canned_replies'
const INBOX_SEARCH_FIELDS = ['name', 'welcome_message']
const CONVERSATION_SEARCH_FIELDS = [
  'visitor_name',
  'visitor_email',
  'subject',
  'status',
  'priority',
  'tags'
]
const MESSAGE_SEARCH_FIELDS = ['sender_name', 'body']
const CONVERSATION_STATUSES = ['open', 'pending', 'snoozed', 'resolved']
const CONVERSATION_PRIORITIES = ['low', 'normal', 'high', 'urgent']

export function createInbox(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const timestamp = system.now()
    const inbox = {
      id: cleanId(request.id) || system.id('inbox'),
      name: cleanText(request.name, 80) || 'Support inbox',
      welcome_message:
        cleanText(request.welcomeMessage ?? request.welcome_message, 280) ||
        'Send us a message and we will reply here.',
      is_active: request.isActive !== false && request.is_active !== false,
      accent_color: cleanColor(request.accentColor) || '#f2a900',
      launcher_text:
        cleanText(request.launcherText, 40) || 'Chat with support',
      offline_message:
        cleanText(request.offlineMessage, 280) ||
        'We are currently offline. Leave a message and we will reply.',
      office_hours_enabled: request.officeHoursEnabled === true,
      office_hours_start: cleanHour(request.officeHoursStart, 9),
      office_hours_end: cleanHour(request.officeHoursEnd, 17),
      created_at: timestamp,
      updated_at: timestamp
    }

    storage.set(INBOXES_TABLE, inbox)
    system.log(`supportchat: created inbox ${inbox.id}`)
    return {inbox: publicInbox(inbox)}
  })
}

export function updateInbox(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    const existing = getInbox(inboxId)
    const inbox = {
      ...existing,
      name: cleanText(request.name, 80) || existing.name,
      welcome_message:
        cleanText(request.welcomeMessage ?? request.welcome_message, 280) ||
        existing.welcome_message,
      is_active:
        request.isActive === undefined && request.is_active === undefined
          ? existing.is_active
          : request.isActive !== false && request.is_active !== false,
      accent_color:
        cleanColor(request.accentColor) ||
        cleanColor(existing.accent_color) ||
        '#f2a900',
      launcher_text:
        cleanText(request.launcherText, 40) ||
        cleanText(existing.launcher_text, 40) ||
        'Chat with support',
      offline_message:
        cleanText(request.offlineMessage, 280) ||
        cleanText(existing.offline_message, 280) ||
        'We are currently offline. Leave a message and we will reply.',
      office_hours_enabled:
        request.officeHoursEnabled === undefined
          ? existing.office_hours_enabled === true
          : request.officeHoursEnabled === true,
      office_hours_start: cleanHour(
        request.officeHoursStart,
        cleanHour(existing.office_hours_start, 9)
      ),
      office_hours_end: cleanHour(
        request.officeHoursEnd,
        cleanHour(existing.office_hours_end, 17)
      ),
      updated_at: system.now()
    }

    storage.set(INBOXES_TABLE, inbox)
    system.log(`supportchat: updated inbox ${inbox.id}`)
    return {inbox: publicInbox(inbox)}
  })
}

export function listInboxes(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const response = storage.getPaginated(INBOXES_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: INBOX_SEARCH_FIELDS,
      sortBy: normalizeInboxSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: normalizePageSize(request.rowsPerPage, 100),
      offset: pageOffset(request, 100)
    })

    return {
      inboxes: response.data.map(publicInbox),
      total: response.total
    }
  })
}

export function deleteInbox(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    const inbox = getInbox(inboxId)
    const conversations = storage.getPaginated(CONVERSATIONS_TABLE, {
      filters: {inbox_id: inboxId},
      limit: 1,
      offset: 0
    })

    if (conversations.total > 0) {
      throw new Error('Inboxes with conversations cannot be deleted.')
    }

    storage.delete(INBOXES_TABLE, inboxId)
    system.log(`supportchat: deleted inbox ${inboxId}`)
    return {id: inbox.id, deleted: true}
  })
}

export function listConversations(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    const inbox = getInbox(inboxId)
    const filters = {inbox_id: inboxId}
    const status = cleanText(request.status, 20)
    const priority = cleanText(request.priority, 20)
    if (CONVERSATION_STATUSES.includes(status)) filters.status = status
    if (CONVERSATION_PRIORITIES.includes(priority)) filters.priority = priority

    const response = storage.getPaginated(CONVERSATIONS_TABLE, {
      filters,
      search: cleanText(request.search, 256),
      searchFields: CONVERSATION_SEARCH_FIELDS,
      sortBy: normalizeConversationSortBy(request.sortBy),
      descending: request.descending !== false && request.descending !== 'false',
      limit: 200,
      offset: 0
    })
    const messageStats = inboxMessageStats(inboxId)
    const conversations = response.data.map(conversation =>
      privateConversation(conversation, messageStats[conversation.id])
    )
    sortConversations(
      conversations,
      normalizeConversationSortBy(request.sortBy),
      request.descending !== false && request.descending !== 'false'
    )
    const pageSize = normalizePageSize(request.rowsPerPage, 100)
    const offset = pageOffset(request, 100)

    return {
      inbox: publicInbox(inbox),
      conversations: conversations.slice(offset, offset + pageSize),
      total: response.total
    }
  })
}

export function listMessages(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    const limit = normalizePageSize(request.rowsPerPage, 200)
    const offset = pageOffset(request, 200)
    const messages = storage.getPaginated(MESSAGES_TABLE, {
      filters: {conversation_id: conversationId},
      search: cleanText(request.search, 256),
      searchFields: MESSAGE_SEARCH_FIELDS,
      sortBy: 'created_at',
      descending: false,
      limit,
      offset
    })
    const notes = storage.getPaginated(INTERNAL_NOTES_TABLE, {
      filters: {conversation_id: conversationId},
      search: cleanText(request.search, 256),
      searchFields: MESSAGE_SEARCH_FIELDS,
      sortBy: 'created_at',
      descending: false,
      limit,
      offset
    })
    const combined = [
      ...messages.data.map(publicMessage),
      ...notes.data.map(internalNote)
    ].sort((left, right) => left.createdAt - right.createdAt)

    return {
      conversation: privateConversation(conversation),
      messages: combined,
      total: messages.total + notes.total
    }
  })
}

export function replyConversation(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    getInbox(conversation.inbox_id)
    const timestamp = system.now()
    const message = {
      id: system.id('msg'),
      conversation_id: conversationId,
      inbox_id: conversation.inbox_id,
      sender_type: 'agent',
      sender_name: cleanText(request.name, 80) || 'Support',
      body: requiredMessage(request.body ?? request.message),
      created_at: timestamp
    }
    storage.set(MESSAGES_TABLE, message)

    const updatedConversation = {
      ...conversation,
      status: 'open',
      snoozed_until: 0,
      agent_last_read_at: timestamp,
      updated_at: timestamp,
      last_message_at: timestamp
    }
    storage.set(CONVERSATIONS_TABLE, updatedConversation)

    publishMessage(updatedConversation, message)
    return {
      conversation: privateConversation(updatedConversation),
      message: publicMessage(message)
    }
  })
}

export function updateConversation(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    const updatedConversation = {
      ...conversation,
      status: hasOwn(request, 'status')
        ? normalizeStatus(request.status)
        : normalizeStatus(conversation.status),
      priority: hasOwn(request, 'priority')
        ? normalizePriority(request.priority)
        : normalizePriority(conversation.priority),
      tags: hasOwn(request, 'tags')
        ? normalizeTags(request.tags)
        : normalizeTags(conversation.tags),
      snoozed_until: hasOwn(request, 'snoozedUntil')
        ? normalizeTimestamp(request.snoozedUntil)
        : normalizeTimestamp(conversation.snoozed_until),
      updated_at: system.now()
    }
    if (updatedConversation.status !== 'snoozed') {
      updatedConversation.snoozed_until = 0
    }

    storage.set(CONVERSATIONS_TABLE, updatedConversation)
    publishConversation(updatedConversation, 'conversation.updated')
    return {conversation: privateConversation(updatedConversation)}
  })
}

export function resolveConversation(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    getInbox(conversation.inbox_id)
    const updatedConversation = {
      ...conversation,
      status: 'resolved',
      snoozed_until: 0,
      updated_at: system.now()
    }
    storage.set(CONVERSATIONS_TABLE, updatedConversation)
    publishConversation(updatedConversation, 'conversation.resolved')
    return {conversation: privateConversation(updatedConversation)}
  })
}

export function markConversationRead(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    const updatedConversation = {
      ...conversation,
      agent_last_read_at: system.now()
    }
    storage.set(CONVERSATIONS_TABLE, updatedConversation)
    return {conversation: privateConversation(updatedConversation)}
  })
}

export function addInternalNote(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getConversation(conversationId)
    const note = {
      id: system.id('note'),
      conversation_id: conversationId,
      inbox_id: conversation.inbox_id,
      sender_name: cleanText(request.name, 80) || 'Support',
      body: requiredMessage(request.body ?? request.message),
      created_at: system.now()
    }
    storage.set(INTERNAL_NOTES_TABLE, note)
    return {note: internalNote(note)}
  })
}

export function listCannedReplies(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    getInbox(inboxId)
    const response = storage.getPaginated(CANNED_REPLIES_TABLE, {
      filters: {inbox_id: inboxId},
      search: cleanText(request.search, 256),
      searchFields: ['title', 'body'],
      sortBy: 'title',
      descending: false,
      limit: normalizePageSize(request.rowsPerPage, 100),
      offset: pageOffset(request, 100)
    })
    return {
      cannedReplies: response.data.map(cannedReply),
      total: response.total
    }
  })
}

export function saveCannedReply(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    getInbox(inboxId)
    const timestamp = system.now()
    const existingId = cleanId(request.id)
    const existing = existingId
      ? storage.get(CANNED_REPLIES_TABLE, existingId)
      : null
    if (existing && existing.inbox_id !== inboxId) {
      throw new Error('Canned reply does not belong to this inbox.')
    }
    const reply = {
      id: existingId || system.id('reply'),
      inbox_id: inboxId,
      title: requiredText(request.title, 'title', 80),
      body: requiredMessage(request.body),
      created_at: Number(existing?.created_at || timestamp),
      updated_at: timestamp
    }
    storage.set(CANNED_REPLIES_TABLE, reply)
    return {cannedReply: cannedReply(reply)}
  })
}

export function deleteCannedReply(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const replyId = requiredText(request.replyId, 'replyId', 128)
    const existing = storage.get(CANNED_REPLIES_TABLE, replyId)
    if (!existing) throw new Error('Canned reply not found.')
    storage.delete(CANNED_REPLIES_TABLE, replyId)
    return {id: replyId, deleted: true}
  })
}

export function getPublicInbox(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    const inbox = getPublicInboxById(inboxId)
    return {inbox: publicInbox(inbox)}
  })
}

export function startConversation(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const inboxId = requiredText(request.inboxId, 'inboxId', 128)
    const inbox = getPublicInboxById(inboxId)
    if (!inbox.is_active) {
      throw new Error('This support inbox is not accepting messages.')
    }

    const timestamp = system.now()
    const body = requiredMessage(request.body ?? request.message)
    const subject =
      cleanText(request.subject, 120) ||
      cleanText(body, 80) ||
      'New conversation'
    const conversationId = storage.appendPublic(CONVERSATIONS_TABLE, inboxId, {
      visitor_name: cleanText(request.name, 80) || 'Guest',
      visitor_email: cleanText(request.email, 160),
      subject,
      status: 'open',
      priority: 'normal',
      tags: [],
      agent_last_read_at: 0,
      snoozed_until: 0,
      created_at: timestamp,
      updated_at: timestamp,
      last_message_at: timestamp
    })
    const conversation = getPublicConversationById(conversationId)
    const message = appendPublicMessage(conversation, {
      body,
      senderName: conversation.visitor_name || 'Guest',
      senderType: 'visitor',
      timestamp
    })

    publishMessage(conversation, message)
    return {
      inbox: publicInbox(inbox),
      conversation: publicConversation(conversation),
      messages: [publicMessage(message)]
    }
  })
}

export function getPublicConversation(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getPublicConversationById(conversationId)
    const inbox = getPublicInboxById(conversation.inbox_id)
    const messages = storage.getPublicPaginated(MESSAGES_TABLE, conversationId, {
      sortBy: 'created_at',
      descending: false,
      limit: normalizePageSize(request.rowsPerPage, 200),
      offset: pageOffset(request, 200)
    })

    return {
      inbox: publicInbox(inbox),
      conversation: publicConversation(conversation),
      messages: messages.data.map(publicMessage),
      total: messages.total
    }
  })
}

export function postPublicMessage(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const conversationId = requiredText(
      request.conversationId,
      'conversationId',
      128
    )
    const conversation = getPublicConversationById(conversationId)
    if (conversation.status === 'resolved') {
      throw new Error('This conversation has been resolved.')
    }
    const timestamp = system.now()
    const recent = storage.getPublicPaginated(MESSAGES_TABLE, conversationId, {
      sortBy: 'created_at',
      descending: true,
      limit: 1,
      offset: 0
    })
    if (
      recent.data.length &&
      timestamp - Number(recent.data[0].created_at || 0) < 1
    ) {
      throw new Error('Please wait before sending another message.')
    }
    const message = appendPublicMessage(conversation, {
      body: requiredMessage(request.body ?? request.message),
      senderName:
        cleanText(request.name, 80) || conversation.visitor_name || 'Guest',
      senderType: 'visitor',
      timestamp
    })

    publishMessage(conversation, message)
    return {
      conversation: publicConversation(conversation),
      message: publicMessage(message)
    }
  })
}

function appendPublicMessage(conversation, input) {
  const row = {
    inbox_id: conversation.inbox_id,
    sender_type: input.senderType,
    sender_name: input.senderName,
    body: input.body,
    created_at: input.timestamp
  }
  const id = storage.appendPublic(MESSAGES_TABLE, conversation.id, row)
  return {
    id,
    conversation_id: conversation.id,
    ...row
  }
}

function inboxMessageStats(inboxId) {
  const response = storage.getPaginated(MESSAGES_TABLE, {
    filters: {inbox_id: inboxId},
    sortBy: 'created_at',
    descending: false,
    limit: 1000,
    offset: 0
  })
  const stats = {}
  for (const message of response.data) {
    const conversationId = message.conversation_id
    if (!stats[conversationId]) {
      stats[conversationId] = {
        lastMessageAt: 0,
        visitorMessageTimes: []
      }
    }
    const createdAt = Number(message.created_at || 0)
    stats[conversationId].lastMessageAt = Math.max(
      stats[conversationId].lastMessageAt,
      createdAt
    )
    if (message.sender_type === 'visitor') {
      stats[conversationId].visitorMessageTimes.push(createdAt)
    }
  }
  return stats
}

function sortConversations(conversations, sortBy, descending) {
  const publicField = {
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    last_message_at: 'lastMessageAt',
    visitor_name: 'visitorName',
    priority: 'priority'
  }[sortBy]
  conversations.sort((left, right) => {
    const a = left[publicField]
    const b = right[publicField]
    const result =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a || '').localeCompare(String(b || ''))
    return descending ? -result : result
  })
}

function publishMessage(conversation, message) {
  const payload = {
    type: 'message.created',
    conversation: publicConversation(conversation),
    message: publicMessage(message)
  }
  websocket.publish(`conversation:${conversation.id}`, payload)
  websocket.publish(`inbox:${conversation.inbox_id}`, payload)
}

function publishConversation(conversation, type) {
  const payload = {
    type,
    conversation: publicConversation(conversation)
  }
  websocket.publish(`conversation:${conversation.id}`, payload)
  websocket.publish(`inbox:${conversation.inbox_id}`, payload)
}

function getInbox(inboxId) {
  const inbox = storage.get(INBOXES_TABLE, inboxId)
  if (!inbox) throw new Error('Support inbox not found.')
  return inbox
}

function getPublicInboxById(inboxId) {
  const inbox = storage.getPublic(INBOXES_TABLE, inboxId)
  if (!inbox) throw new Error('Support inbox not found.')
  return inbox
}

function getConversation(conversationId) {
  const conversation = storage.get(CONVERSATIONS_TABLE, conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  return conversation
}

function getPublicConversationById(conversationId) {
  const conversation = storage.getPublic(CONVERSATIONS_TABLE, conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  return conversation
}

function publicInbox(inbox) {
  const current = system.now()
  return {
    id: inbox.id,
    name: inbox.name,
    welcomeMessage: inbox.welcome_message,
    isActive: inbox.is_active === true,
    accentColor: cleanColor(inbox.accent_color) || '#f2a900',
    launcherText: cleanText(inbox.launcher_text, 40) || 'Chat with support',
    offlineMessage:
      cleanText(inbox.offline_message, 280) ||
      'We are currently offline. Leave a message and we will reply.',
    officeHoursEnabled: inbox.office_hours_enabled === true,
    officeHoursStart: cleanHour(inbox.office_hours_start, 9),
    officeHoursEnd: cleanHour(inbox.office_hours_end, 17),
    isOnline: inbox.is_active === true && isWithinOfficeHours(inbox, current),
    createdAt: Number(inbox.created_at || 0),
    updatedAt: Number(inbox.updated_at || 0)
  }
}

function publicConversation(conversation) {
  return {
    id: conversation.id,
    inboxId: conversation.inbox_id,
    visitorName: conversation.visitor_name,
    subject: conversation.subject,
    status: normalizeStatus(conversation.status),
    createdAt: Number(conversation.created_at || 0),
    updatedAt: Number(conversation.updated_at || 0),
    lastMessageAt: Number(conversation.last_message_at || 0)
  }
}

function privateConversation(conversation, stats = null) {
  const agentLastReadAt = Number(conversation.agent_last_read_at || 0)
  const visitorMessageTimes = stats?.visitorMessageTimes || []
  return {
    ...publicConversation(conversation),
    visitorEmail: conversation.visitor_email,
    priority: normalizePriority(conversation.priority),
    tags: normalizeTags(conversation.tags),
    unreadCount: visitorMessageTimes.filter(
      timestamp => timestamp > agentLastReadAt
    ).length,
    agentLastReadAt,
    snoozedUntil: normalizeTimestamp(conversation.snoozed_until),
    lastMessageAt: Math.max(
      Number(conversation.last_message_at || 0),
      Number(stats?.lastMessageAt || 0)
    )
  }
}

function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    inboxId: message.inbox_id,
    senderType: message.sender_type,
    senderName: message.sender_name,
    body: message.body,
    createdAt: Number(message.created_at || 0)
  }
}

function internalNote(note) {
  return {
    id: note.id,
    conversationId: note.conversation_id,
    inboxId: note.inbox_id,
    senderType: 'internal_note',
    senderName: note.sender_name,
    body: note.body,
    createdAt: Number(note.created_at || 0)
  }
}

function cannedReply(reply) {
  return {
    id: reply.id,
    inboxId: reply.inbox_id,
    title: reply.title,
    body: reply.body,
    createdAt: Number(reply.created_at || 0),
    updatedAt: Number(reply.updated_at || 0)
  }
}

function isWithinOfficeHours(inbox, timestamp) {
  if (inbox.office_hours_enabled !== true) return true
  const start = cleanHour(inbox.office_hours_start, 9)
  const end = cleanHour(inbox.office_hours_end, 17)
  if (start === end) return false
  const hour = new Date(timestamp * 1000).getUTCHours()
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    system.log(`supportchat: ${message}`, 'warning')
    return JSON.stringify({ok: false, error: message})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed
}

function requiredText(value, name, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${name} is required.`)
  return text
}

function requiredMessage(value) {
  const body = cleanMessage(value, 2000)
  if (!body) throw new Error('Message is required.')
  return body
}

function cleanId(value) {
  const text = cleanText(value, 128)
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : ''
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function cleanMessage(value, maxLength) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength)
}

function cleanColor(value) {
  const color = cleanText(value, 7)
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : ''
}

function cleanHour(value, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 23) return fallback
  return number
}

function normalizeStatus(value) {
  const status = cleanText(value, 20)
  return CONVERSATION_STATUSES.includes(status) ? status : 'open'
}

function normalizePriority(value) {
  const priority = cleanText(value, 20)
  return CONVERSATION_PRIORITIES.includes(priority) ? priority : 'normal'
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : String(value || '').split(',')
  return [
    ...new Set(tags.map(tag => cleanText(tag, 32).toLowerCase()).filter(Boolean))
  ].slice(0, 10)
}

function normalizeTimestamp(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

function normalizePageSize(value, fallback = 25) {
  const number = Number(value || fallback)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(Math.trunc(number), 200))
}

function normalizePage(value) {
  const number = Number(value || 1)
  if (!Number.isFinite(number) || number <= 0) return 1
  return Math.trunc(number)
}

function pageOffset(request, fallback = 25) {
  return (
    (normalizePage(request.page) - 1) *
    normalizePageSize(request.rowsPerPage, fallback)
  )
}

function normalizeInboxSortBy(value) {
  return ['name', 'created_at', 'updated_at'].includes(value) ? value : 'created_at'
}

function normalizeConversationSortBy(value) {
  return [
    'created_at',
    'updated_at',
    'last_message_at',
    'visitor_name',
    'priority'
  ].includes(value)
    ? value
    : 'last_message_at'
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}
