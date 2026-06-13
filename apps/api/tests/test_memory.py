from kumikoroom.memory import MemoryStore, extract_memories


def test_memory_store_saves_lists_deletes_and_clears(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")

    saved = store.save(
        category="preference",
        text="用户喜欢安静的钢琴曲。",
        confidence=0.82,
        source="喜欢安静的钢琴",
    )

    assert saved.category == "preference"
    assert saved.text == "用户喜欢安静的钢琴曲。"
    assert saved.confidence == 0.82
    assert len(store.list_recent(limit=10)) == 1

    assert store.delete(saved.id) is True
    assert store.list_recent(limit=10) == []

    store.save(
        category="diary",
        text="用户今天听歌时心情平静。",
        confidence=0.78,
        source="今天听歌",
    )
    store.clear()
    assert store.list_recent(limit=10) == []


def test_extract_memories_captures_medium_sensitivity_items():
    memories = extract_memories(
        user_message="我喜欢安静的钢琴，也想把这个 demo 明天继续编曲。",
        assistant_reply="嗯，我记一下。",
    )

    assert [memory.category for memory in memories] == ["preference", "creative_note"]
    assert any("安静的钢琴" in memory.text for memory in memories)
    assert any("demo" in memory.text for memory in memories)


def test_extract_memories_filters_secrets_and_casual_text():
    fake_secret = "sk-" + "abc12345678900000000"
    assert extract_memories(f"我的 key 是 {fake_secret}", "别保存。") == []
    assert extract_memories("我的key是abc123，我喜欢钢琴。", "别保存。") == []
    assert extract_memories("哈哈，随便聊聊。", "嗯。") == []


def test_extract_memories_filters_common_secret_shapes():
    secret_messages = [
        "我的 password 是 abc123，我喜欢钢琴。",
        "my secret is abc，我喜欢钢琴。",
        "token: abc123，我喜欢钢琴。",
        "Bearer abcdef1234567890abcdef1234567890，我喜欢钢琴。",
        "ghp_abcdefghijklmnopqrstuvwxyz123456，我喜欢钢琴。",
        "AKIAIOSFODNN7EXAMPLE，我喜欢钢琴。",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature，我喜欢钢琴。",
        "sk-proj-abc12345678900000000，我喜欢钢琴。",
    ]

    for message in secret_messages:
        assert extract_memories(message, "别保存。") == []


def test_extract_memories_filters_labeled_short_credentials_without_assignment():
    secret_messages = [
        "my password abc123，我喜欢钢琴。",
        "my token abc123，我喜欢钢琴。",
        "my secret abc123，我喜欢钢琴。",
    ]

    for message in secret_messages:
        assert extract_memories(message, "别保存。") == []


def test_extract_memories_allows_musical_key_context():
    memories = extract_memories("我喜欢这首歌的 key 定成 C major，之后继续编曲。", "嗯。")

    assert [memory.category for memory in memories] == ["preference", "creative_note"]


def test_extract_memories_allows_secret_garden_music_context():
    memories = extract_memories("我喜欢 Secret Garden 那种旋律，之后继续编曲。", "嗯。")

    assert [memory.category for memory in memories] == ["preference", "creative_note"]
    assert any("Secret Garden" in memory.text for memory in memories)


def test_extract_memories_allows_compact_musical_key_context():
    memories = extract_memories("我喜欢这首歌的 key=Cmajor，之后继续编曲。", "嗯。")

    assert [memory.category for memory in memories] == ["preference", "creative_note"]


def test_extract_memories_still_filters_key_assignments_with_credentials():
    assert extract_memories("我的 key=abc123456789abcdef，我喜欢钢琴。", "别保存。") == []


def test_extract_memories_skips_short_term_questions_and_clarifications():
    assert extract_memories("今天这个接口怎么用？", "我解释一下。") == []
    assert extract_memories("我是说刚才那个按钮没反应。", "明白。") == []


def test_memory_store_lists_newest_first_and_normalizes_saved_values(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")

    first = store.save(
        category="preference",
        text="  用户喜欢钢琴。  ",
        confidence=0.824,
        source="  喜欢钢琴  ",
    )
    second = store.save(
        category="creative_note",
        text="用户想继续 demo 编曲。",
        confidence=0.786,
        source="demo 编曲",
    )

    records = store.list_recent(limit=10)

    assert [record.id for record in records] == [second.id, first.id]
    assert records[0].confidence == 0.79
    assert records[1].text == "用户喜欢钢琴。"
    assert records[1].source == "喜欢钢琴"


def test_memory_store_delete_missing_returns_false(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")

    assert store.delete("missing") is False
