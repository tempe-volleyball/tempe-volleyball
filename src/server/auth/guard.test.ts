import { describe, expect, it } from 'vitest'
import { guard, needsSession, safeNext, type GuardRequest, type GuardUser } from './guard'

const SITE = 'https://tempe-volleyball-staging.tempevb.workers.dev'
const req = (pathname: string, extra: Partial<GuardRequest> = {}): GuardRequest => ({
  pathname,
  method: 'GET',
  origin: null,
  secFetchSite: null,
  allowedOrigins: [SITE],
  ...extra,
})

const owner: GuardUser = { role: 'owner', twoFactorEnabled: true }
const ownerNoTotp: GuardUser = { role: 'owner', twoFactorEnabled: false }
const editor: GuardUser = { role: 'editor', twoFactorEnabled: false }

describe('admin pages', () => {
  it('sends signed-out visitors to sign-in, remembering where they were going', () => {
    expect(guard(req('/admin'), null)).toEqual({ action: 'redirect', to: '/admin/sign-in' })
    expect(guard(req('/admin/'), null)).toEqual({ action: 'redirect', to: '/admin/sign-in' })
    expect(guard(req('/admin/users', { search: '?tab=invites' }), null)).toEqual({
      action: 'redirect',
      to: '/admin/sign-in?next=%2Fadmin%2Fusers%3Ftab%3Dinvites',
    })
  })

  it('leaves sign-in and invite acceptance open', () => {
    expect(guard(req('/admin/sign-in'), null)).toEqual({ action: 'next' })
    expect(guard(req('/admin/invite'), null)).toEqual({ action: 'next' })
    expect(guard(req('/admin/invite'), editor)).toEqual({ action: 'next' })
  })

  it('moves signed-in users off the sign-in page', () => {
    expect(guard(req('/admin/sign-in'), editor)).toEqual({ action: 'redirect', to: '/admin' })
    expect(guard(req('/admin/sign-in'), ownerNoTotp)).toEqual({ action: 'redirect', to: '/admin/security' })
  })

  it('sends an owner without TOTP to enrolment before any other admin page', () => {
    for (const p of ['/admin', '/admin/users', '/admin/audit', '/admin/pages/1']) {
      expect(guard(req(p), ownerNoTotp)).toEqual({ action: 'redirect', to: '/admin/security?required=1' })
    }
    expect(guard(req('/admin/security'), ownerNoTotp)).toEqual({ action: 'next' })
    expect(guard(req('/admin/users'), owner)).toEqual({ action: 'next' })
  })

  it("doesn't require TOTP of admins and editors", () => {
    expect(guard(req('/admin/users'), editor)).toEqual({ action: 'next' })
    expect(guard(req('/admin'), { role: 'admin', twoFactorEnabled: null })).toEqual({ action: 'next' })
  })
})

describe('admin APIs', () => {
  it('returns 401 without a session', () => {
    expect(guard(req('/api/admin/users'), null)).toEqual({ action: 'json', status: 401, error: 'unauthenticated' })
    expect(guard(req('/api/admin/me'), null)).toEqual({ action: 'json', status: 401, error: 'unauthenticated' })
  })

  it('returns 403 totp_required for an owner without TOTP, except /me', () => {
    expect(guard(req('/api/admin/users'), ownerNoTotp)).toEqual({ action: 'json', status: 403, error: 'totp_required' })
    expect(guard(req('/api/admin/me'), ownerNoTotp)).toEqual({ action: 'next' })
  })

  it('rejects cross-origin writes before anything else', () => {
    const write = (extra: Partial<GuardRequest>) => req('/api/admin/users/x', { method: 'PATCH', ...extra })
    expect(guard(write({ origin: 'https://evil.example' }), owner)).toEqual({ action: 'json', status: 403, error: 'bad_origin' })
    expect(guard(write({}), owner)).toEqual({ action: 'json', status: 403, error: 'bad_origin' })
    expect(guard(write({ secFetchSite: 'cross-site' }), owner)).toEqual({ action: 'json', status: 403, error: 'bad_origin' })
    expect(guard(write({ origin: SITE }), owner)).toEqual({ action: 'next' })
    expect(guard(write({ secFetchSite: 'same-origin' }), owner)).toEqual({ action: 'next' })
    expect(guard(write({ origin: 'https://evil.example' }), null)).toEqual({ action: 'json', status: 403, error: 'bad_origin' })
    // Reads don't need the check.
    expect(guard(req('/api/admin/users', { origin: 'https://evil.example' }), owner)).toEqual({ action: 'next' })
  })

  it('leaves the invite APIs public but same-origin', () => {
    expect(guard(req('/api/invites/accept', { method: 'POST', origin: SITE }), null)).toEqual({ action: 'next' })
    expect(guard(req('/api/invites/accept', { method: 'POST', origin: 'https://evil.example' }), null)).toMatchObject({ status: 403 })
  })
})

describe('everything else', () => {
  it('passes public pages through without needing a session', () => {
    expect(guard(req('/'), null)).toEqual({ action: 'next' })
    expect(guard(req('/administration'), null)).toEqual({ action: 'next' })
    expect(needsSession('/')).toBe(false)
    expect(needsSession('/administration')).toBe(false)
    expect(needsSession('/api/health')).toBe(false)
    expect(needsSession('/admin')).toBe(true)
    expect(needsSession('/api/admin/me')).toBe(true)
  })
})

describe('safeNext', () => {
  it('only allows admin paths on this site', () => {
    expect(safeNext('/admin/users?x=1')).toBe('/admin/users?x=1')
    expect(safeNext(null)).toBe('/admin')
    expect(safeNext('https://evil.example/admin')).toBe('/admin')
    expect(safeNext('//evil.example/admin')).toBe('/admin')
    expect(safeNext('/admin\\@evil')).toBe('/admin')
    expect(safeNext('/elsewhere')).toBe('/admin')
    expect(safeNext('/admin/sign-in')).toBe('/admin')
  })
})
