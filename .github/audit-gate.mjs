import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const allowlistPath = join(repoRoot, '.github', 'audit-allowlist.json')
const workspace = process.env.AUDIT_WORKSPACE ?? '@cch/landing'
const DAY_MS = 86_400_000
const WARN_WITHIN_DAYS = 3
const MAX_UNTIL_DAYS = 30

const isRealDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const daysUntil = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)

const readAllowlist = (today) => {
  const entries = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  for (const entry of entries) {
    if (!entry.ghsa || !entry.module || !entry.reason || !isRealDate(entry.until)) {
      throw new Error(`Invalid allowlist entry: ${JSON.stringify(entry)}`)
    }
    if (daysUntil(entry.until, today) > MAX_UNTIL_DAYS) {
      throw new Error(
        `Allowlist entry ${entry.module} ${entry.ghsa} expires ${entry.until}, more than ${MAX_UNTIL_DAYS} days ahead`
      )
    }
  }
  return entries
}

const readAdvisories = () => {
  if (!existsSync(join(repoRoot, 'package-lock.json'))) throw new Error(`package-lock.json not found in ${repoRoot}`)
  const args = ['audit', '--omit=dev', '--json']
  if (workspace !== 'all') args.push('-w', workspace)
  const audit = spawnSync('npm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024
  })
  if (audit.error) throw audit.error
  let report
  try {
    report = JSON.parse(audit.stdout)
  } catch {
    throw new Error(`npm audit returned no JSON (exit ${audit.status}): ${audit.stderr}`)
  }
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`)
  if (report.auditReportVersion !== 2 || !report.vulnerabilities || !(report.metadata?.dependencies?.prod > 0)) {
    throw new Error(`npm audit report not recognized or inspected no production dependencies (exit ${audit.status})`)
  }
  const advisories = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue
      const ghsa = via.url.split('/').pop()
      const current = advisories.get(ghsa) ?? {
        ghsa,
        module: via.name,
        severity: via.severity,
        title: via.title,
        paths: new Set()
      }
      for (const node of report.vulnerabilities[via.name]?.nodes ?? vulnerability.nodes) current.paths.add(node)
      advisories.set(ghsa, current)
    }
  }
  return [...advisories.values()]
}

const today = new Date().toISOString().slice(0, 10)
const allowlist = readAllowlist(today)
const advisories = readAdvisories()
const failures = []

for (const advisory of advisories) {
  const entry = allowlist.find((item) => item.ghsa === advisory.ghsa && item.module === advisory.module)
  const where = [...advisory.paths].slice(0, 3).join(', ')
  if (!entry) {
    failures.push(`NOT ALLOWED ${advisory.severity} ${advisory.module} ${advisory.ghsa} (${where}): ${advisory.title}`)
  } else if (entry.until < today) {
    failures.push(`EXPIRED ${advisory.module} ${advisory.ghsa} (${where}) allowed until ${entry.until}: ${entry.reason}`)
  } else {
    console.log(`allowed until ${entry.until}: ${advisory.severity} ${advisory.module} ${advisory.ghsa} (${where})`)
    const remaining = daysUntil(entry.until, today)
    if (remaining <= WARN_WITHIN_DAYS) {
      console.log(
        `::warning::audit exception for ${advisory.module} ${advisory.ghsa} expires ${entry.until} (${remaining} days left)`
      )
    }
  }
}

for (const entry of allowlist) {
  if (!advisories.some((advisory) => advisory.ghsa === entry.ghsa)) {
    console.log(`unused allowlist entry, remove it: ${entry.module} ${entry.ghsa}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}
console.log(`audit gate passed (${workspace}): ${advisories.length} advisories, all allowed`)
