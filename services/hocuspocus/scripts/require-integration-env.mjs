if (!process.env.HOCUSPOCUS_TEST_DATABASE_URL) {
  console.error(
    [
      'HOCUSPOCUS_TEST_DATABASE_URL is required for Hocuspocus integration tests.',
      '',
      'Local Docker option:',
      '  docker compose -f docker-compose.dev.yml up -d postgres',
      '  HOCUSPOCUS_TEST_DATABASE_URL=postgres://dohc:dohc@127.0.0.1:54329/dohc_v2 pnpm test:hocuspocus:integration',
    ].join('\n'),
  )
  process.exit(1)
}
