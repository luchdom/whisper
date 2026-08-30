# Third-party notices

Meeting Transcriber uses open-source runtime libraries listed in `package.json` and `backend/pyproject.toml`. Their package distributions include their respective license metadata. Standalone distributions also include a CycloneDX `SBOM.cdx.json` generated from the runtime packages observed in that platform's PyInstaller analysis.

The repository bundles a schema-v1 integrity manifest, not model artifacts. ASR, speaker, and translation source artifacts are downloaded on demand from the sources below only when the user starts a feature that needs them. Standalone installers do not redistribute those models.

## Standalone application runtime

Platform distributions bundle these major runtime families. The SBOM explicitly records the embedded CPython version and the versions of observed packaged dependencies. Build-environment tools are recorded separately and are not labeled as required runtime dependencies. Transitive Python inputs are platform-resolved rather than an immutable cross-platform lock.

- CPython 3.12.x — Python Software Foundation License Version 2.
- PyInstaller bootloader — GNU General Public License Version 2 or later with the PyInstaller bootloader exception, which permits distribution with the bundled application.
- Electron — MIT License; its embedded Chromium and Node.js distributions carry their upstream BSD-style and MIT notices.
- Faster-Whisper and CTranslate2 — MIT License.
- Hugging Face Hub, SentencePiece, Sherpa-ONNX, FlatBuffers, and Tokenizers — Apache License 2.0.
- ONNX Runtime — MIT License.
- NumPy and PyAV — BSD 3-Clause licenses.

The installed runtime contains no package manager and never modifies system Python. Model licenses and attribution remain separate below because model files are provisioned only after an explicit feature start.

## Faster-Whisper ASR artifacts

The application offers these 14 CTranslate2-converted Whisper artifacts. Each manifest entry uses the listed repository and full commit revision plus exact per-file sizes and SHA-256 digests. All are licensed under the MIT License.

| Display choice | Repository | Immutable revision |
|---|---|---|
| Tiny — Multilingual | [`Systran/faster-whisper-tiny`](https://huggingface.co/Systran/faster-whisper-tiny) | `d90ca5fe260221311c53c58e660288d3deb8d356` |
| Tiny — English only | [`Systran/faster-whisper-tiny.en`](https://huggingface.co/Systran/faster-whisper-tiny.en) | `0d3d19a32d3338f10357c0889762bd8d64bbdeba` |
| Base — Multilingual | [`Systran/faster-whisper-base`](https://huggingface.co/Systran/faster-whisper-base) | `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66` |
| Base — English only | [`Systran/faster-whisper-base.en`](https://huggingface.co/Systran/faster-whisper-base.en) | `3d3d5dee26484f91867d81cb899cfcf72b96be6c` |
| Small — Multilingual | [`Systran/faster-whisper-small`](https://huggingface.co/Systran/faster-whisper-small) | `536b0662742c02347bc0e980a01041f333bce120` |
| Small — English only | [`Systran/faster-whisper-small.en`](https://huggingface.co/Systran/faster-whisper-small.en) | `d1d751a5f8271d482d14ca55d9e2deeebbae577f` |
| Distil Small — English only | [`Systran/faster-distil-whisper-small.en`](https://huggingface.co/Systran/faster-distil-whisper-small.en) | `ef77d90526ccd62cde3808ee70626a01e5cf83e4` |
| Medium — Multilingual | [`Systran/faster-whisper-medium`](https://huggingface.co/Systran/faster-whisper-medium) | `08e178d48790749d25932bbc082711ddcfdfbc4f` |
| Medium — English only | [`Systran/faster-whisper-medium.en`](https://huggingface.co/Systran/faster-whisper-medium.en) | `a29b04bd15381511a9af671baec01072039215e3` |
| Distil Medium — English only | [`Systran/faster-distil-whisper-medium.en`](https://huggingface.co/Systran/faster-distil-whisper-medium.en) | `80ddfce281f77766d8943d63109199fc8145dfa5` |
| Distil Large v3 — English only | [`Systran/faster-distil-whisper-large-v3`](https://huggingface.co/Systran/faster-distil-whisper-large-v3) | `c3058b475261292e64a0412df1d2681c06260fab` |
| Distil Large v3.5 — English only | [`distil-whisper/distil-large-v3.5-ct2`](https://huggingface.co/distil-whisper/distil-large-v3.5-ct2) | `9793ccc07920e0f830e1dba0343efcdf0ef8c903` |
| Large v3 Turbo — Multilingual | [`dropbox-dash/faster-whisper-large-v3-turbo`](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo) | `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf` |
| Large v3 — Multilingual | [`Systran/faster-whisper-large-v3`](https://huggingface.co/Systran/faster-whisper-large-v3) | `edaa852ec7e145841d8ffdb056a99866b5f0a478` |

The original [OpenAI Whisper](https://github.com/openai/whisper) code and weights are also MIT-licensed. The manifest records the converted artifact license with each entry.

## Anonymous speaker model

When anonymous speaker detection is enabled for the first time, the app downloads this model on demand. It is not bundled in this repository.

- File: `wespeaker_en_voxceleb_CAM++.onnx`
- Exact size: `29,292,684` bytes
- SHA-256: `c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef`
- Upstream project: [WeSpeaker](https://github.com/wenet-e2e/wespeaker)
- Runtime repository and pinned commit: [`k2-fsa/sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) at `0e23f82691d3ea3a2fca7e698684e2c0c89eb95c`
- Runtime release: [`speaker-recongition-models`](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) (upstream tag spelling)
- Training dataset family: VoxCeleb
- Model license: CC BY 4.0, inherited from the training dataset according to the [WeSpeaker pretrained-model documentation](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)
- Code licenses: WeSpeaker and sherpa-onnx use the Apache License 2.0

The application verifies the expected file size and SHA-256 digest before every load. Redistribution in a future installer must preserve the applicable attribution and license terms.

## English-to-Brazilian-Portuguese translation model

When local translation is enabled on supported Windows x64 systems, the application downloads the original Marian archive below and converts it locally to CTranslate2 INT8. Neither the source archive nor the converted model is bundled in this repository.

- Upstream model: [`Helsinki-NLP/opus-mt-tc-big-en-pt`](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-pt)
- Upstream revision: `9f2863d807ecf91a374bdbecb8d01e402e90622e`
- Source project: [OPUS-MT / Tatoeba Challenge](https://github.com/Helsinki-NLP/Tatoeba-Challenge/tree/master/models/eng-por)
- Source archive: [`opusTCv20210807+bt_transformer-big_2022-03-13.zip`](https://object.pouta.csc.fi/Tatoeba-MT-models/eng-por/opusTCv20210807+bt_transformer-big_2022-03-13.zip)
- Exact source size: `863,398,393` bytes
- Source SHA-256: `62aeb8916c2463351a2dd8d1ea51fcf3929fb3daab7261dcae8d5599e886c008`
- Model license: CC BY 4.0
- Brazilian-Portuguese target label: `>>pob<<`

The application verifies the source archive and every expected archive member before conversion. The conversion output also has an exact Windows x64 size/hash manifest. The local output retains the supplied `README.md` and `LICENSE` files so attribution remains available with the adapted model.

## Model runtime and tokenizer

- [CTranslate2](https://github.com/OpenNMT/CTranslate2) `4.8.1` — MIT License. It runs Faster-Whisper and performs/runs the local OPUS-MT conversion.
- [SentencePiece](https://github.com/google/sentencepiece) `0.2.2` — Apache License 2.0. It tokenizes and detokenizes local translation text.

No notice above grants permission beyond its upstream license. A future bundled-model release must re-evaluate redistribution, attribution, signing, and platform-specific artifact requirements.
