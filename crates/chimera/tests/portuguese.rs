use chimera::phonetics::portuguese::PortugueseG2P;

fn phones(word: &str) -> String {
    PortugueseG2P::new().word(word, false).iter().map(|s| s.ipa.as_str()).collect()
}

#[test]
fn brazilian_consonants_and_final_vowels() {
    for (word, expected) in [("dia", "dʒiɐ"), ("tardes", "taʁdʒis"), ("brasil", "bɾaziw"), ("que", "ki"), ("filho", "fiʎu"), ("ninho", "niɲu")] {
        assert_eq!(phones(word), expected, "{word}");
    }
}

#[test]
fn phrase_boundaries_and_offline_dictionary() {
    let mut g2p = PortugueseG2P::new();
    g2p.load_dict("teste\tˈtɛstʃi\n");
    assert_eq!(g2p.word("TESTE", true)[0].ipa, "t");
    let phrases = g2p.to_phrases("Olá! Tudo bem?");
    assert_eq!(phrases.len(), 2);
    assert_eq!(phrases[1].intonation, chimera::phonetics::Intonation::Question);
    for phrase in phrases {
        assert_eq!(phrase.segments.iter().filter(|s| s.word_end == Some(true)).count(), phrase.words.len());
    }
}
