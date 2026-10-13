/**
 * Throwaway certificate authority used only by tests of the persistent-authority boundary.
 *
 * It carries the exact `C=EN, O=AdGuard, CN=AdGuard Filters Agent` subject the pinned release
 * produces. Its key protects nothing: it was generated for this repository's tests and is never
 * used by a run.
 */

export const PERSISTENT_CA_TEST_CERTIFICATE_PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIDbzCCAlegAwIBAgIUYVkcl+DO9KVFLnI4YLJ/X+drTEswDQYJKoZIhvcNAQEL',
    'BQAwPzELMAkGA1UEBhMCRU4xEDAOBgNVBAoMB0FkR3VhcmQxHjAcBgNVBAMMFUFk',
    'R3VhcmQgRmlsdGVycyBBZ2VudDAeFw0yNjA3MjgxMTExMjJaFw0zNjA3MjUxMTEx',
    'MjJaMD8xCzAJBgNVBAYTAkVOMRAwDgYDVQQKDAdBZEd1YXJkMR4wHAYDVQQDDBVB',
    'ZEd1YXJkIEZpbHRlcnMgQWdlbnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK',
    'AoIBAQDcwr36msPi/CtcHvRnF5Oizy0+e1PXz6gdU/FyjJSPkKQX6MYWB/ubDaCb',
    'uU01APZH+nR730ByFauu8uj05uujd3DjCNnGkmFNzeRCaEV3P066QHucq5UkqG23',
    'g1Bn5atnlgSz2vBQkqKLpK+F4zi8QnacAxm8j6gp5pZFYfPXOucqe/e2bWsFCLLt',
    'EQVtvyFFJMdeREaxxTnf/eWha9em5MYTq0BFFkiCOKRid8u6YlFQQjoiQELCs7o9',
    '4Y3zkYvxLmKJrA9PgpzervanfDmHlHE/xcLw540jIy3ImsOFIYpsd1Lwmlzk8ptx',
    '4DwSV7PQaW092Fgvf0muH/+UmPzFAgMBAAGjYzBhMB0GA1UdDgQWBBQ1XRkGzKKM',
    'SoJTgIRWnLtzhlfKyDAfBgNVHSMEGDAWgBQ1XRkGzKKMSoJTgIRWnLtzhlfKyDAP',
    'BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOC',
    'AQEAxZuBa1uNMUsVcy99dOtElt+K6zTfy2rzaGF6XmiB5I5/S/gFxPEYDYcpUoak',
    'FPP6XXU//FKR8c2/0TywfE3k+OABNvaMRCLSipxiVR9hxByseOPZdzua6Qg5nO9x',
    '1fRJ+QvyYtfFbKzdBJfNb/eLGMv3Zgt4TKh9ccQBbbMEhsPgh75Y5p0aRdYI7ILm',
    'n0BjWgQmFQWwjrALmMYftTrlbkjn8o/z9m8dXmf9RnaOL8YKPmhVFxYhWNrCiHLM',
    'zAORTVHS2yy7u1Jgg8DNWz5xu8dTCy8l7Vmq3Q+OjuSv209oNk1TdrFYAPOn4M1f',
    'F6AosvTBXT+Eo1GLBDP6PKcXZQ==',
    '-----END CERTIFICATE-----',
    '',
].join('\n');
