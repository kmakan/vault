// Набор мутаций: rust-envelope
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-envelope',
  file: 'vault-client/src/vault/envelope.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "маркер версии конверта уезжает (получатель не признает письмо своим)",
      pattern: "        vault: 1,",
      replacement: "        vault: 2," },
    { name: "аватар группы попадает в конверт даже когда его нет",
      pattern: "        gavatar: nonempty(&input.gavatar),",
      replacement: "        gavatar: Some(\"\")," },
    { name: "пустое значение PQ-ключа попадает в конверт (поле «есть» при пустом значении)",
      pattern: "        pq: nonempty(&input.pq_ek),",
      replacement: "        pq: input.pq_ek.as_deref()," },
    { name: "ttl попадает в конверт даже при нуле (получатель поставит таймер удаления)",
      pattern: "        ttl: if input.ttl_secs > 0 {\n            Some(input.ttl_secs)\n        } else {\n            None\n        },",
      replacement: "        ttl: Some(input.ttl_secs.max(0))," },
    { name: "имя отправителя теряется (получатель увидит «нет имени»)",
      pattern: "        name: &input.name,",
      replacement: "        name: \"\"," },
    { name: "текст сообщения теряется",
      pattern: "        text: &input.text,",
      replacement: "        text: \"\"," },
  ],
};
