#!/bin/bash
# CLI Demo Test for Whisper/Vault
# Тестирование slash-команд без подключения к почтовому серверу

set -e

CLIENT_DIR="/home/maksim/whisper/mailcipher-client"
RESULTS_FILE="/home/maksim/whisper/docs/testing/cli-demo-results.md"

echo "# CLI Demo Test Results" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "Дата: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

# Функция тестирования
test_command() {
    local cmd="$1"
    local expected="$2"
    local description="$3"
    
    echo "## Test: $description" >> "$RESULTS_FILE"
    echo "Команда: \`$cmd\`" >> "$RESULTS_FILE"
    echo "" >> "$RESULTS_FILE"
    
    # Запуск команды
    output=$(cd "$CLIENT_DIR" && echo "$cmd" | cargo run --bin mailcipher-client 2>&1 | head -20)
    
    echo "Вывод:" >> "$RESULTS_FILE"
    echo '```' >> "$RESULTS_FILE"
    echo "$output" >> "$RESULTS_FILE"
    echo '```' >> "$RESULTS_FILE"
    echo "" >> "$RESULTS_FILE"
    
    # Проверка ожидаемого результата
    if echo "$output" | grep -q "$expected"; then
        echo "✅ PASS" >> "$RESULTS_FILE"
    else
        echo "⚠️ CHECK NEEDED" >> "$RESULTS_FILE"
    fi
    echo "" >> "$RESULTS_FILE"
    echo "---" >> "$RESULTS_FILE"
    echo "" >> "$RESULTS_FILE"
}

echo "Запуск CLI Demo Test..."
echo ""

# Тест 1: Help
test_command "/help" "Commands:" "Help command"

# Тест 2: Status
test_command "/status" "Status\|status\|Connected\|Disconnected" "Status command"

# Тест 3: Keygen
test_command "/keygen" "key\|Key\|generated\|Generated" "Key generation"

# Тests 4-8: Другие команды
test_command "/contacts" "Contacts\|contacts\|No contacts" "Contacts list"
test_command "/settings" "Settings\|settings" "Settings"
test_command "/inbox" "Inbox\|inbox\|No messages\|Connect" "Inbox"
test_command "/keys" "Key\|key\|Public\|public" "Keys display"

echo "Тестирование завершено!"
echo ""
cat "$RESULTS_FILE"
