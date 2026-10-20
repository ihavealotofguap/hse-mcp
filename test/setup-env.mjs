// Предзагрузка для `npm test` (node --import): тесты не должны трогать настоящее системное хранилище
// паролей (Credential Manager / Keychain / Secret Service), поэтому оно отключено для всех файлов.
process.env.HSE_DISABLE_KEYCHAIN = "true";
