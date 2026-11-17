# Gemini向け Notion MCP OAuthファサード 設計メモ

Nov 17, 2026 · @Kosuke

## 背景と目的

Gemini(Spark)のカスタムアプリ経由の Notion MCP は一定時間で切れ、再認可が必要になる。Gemini には自前の OAuth サーバーだけを見せ、Notion の資格情報をその裏に保持する「ファサード」を Cloud Run に置いて、この問題を避ける。

**症状(ユーザー報告)**: Notion の認証が1時間ほどで切れる(公式の約8時間ではない可能性)。Gemini の Web/デスクトップの汎用 MCP クライアントがリフレッシュトークンを使わないと推測している。Antigravity CLI では再現せず、Claude と ChatGPT の Notion 連携でも起きない。

**ゴール**

- Gemini(Web/Spark)から Notion の共通メモリ(Core Memory / Memory DB)を、再認可なしで数週間以上使い続けられる。
- 実装を Antigravity CLI または Claude Code に渡せる粒度で定義する。
- 単一ユーザーの個人利用で、運用の手間と費用を最小にする。

**非ゴール**

- 複数ユーザー対応と課金。
- Notion ホスト版 MCP の全ツールの再現。
- Gemini 以外のクライアント対応(Phase 4 の任意項目)。

## 調査で分かったこと

Notion 側の仕様は確認済みだが、Gemini 側の実際の挙動は未確定。Phase 0 で Gemini の挙動を観察して仮説を絞る。切れるまでの実測時間(1時間か8時間か)もまだ測っていない。

| 確認できた事実 | 内容 | 出典と確度 |
| --- | --- | --- |
| Notion MCP のアクセストークン寿命 | 約8時間(2026-07-14 に1時間から延長)。固定値を前提にせず expires\_in を使う | [Notion changelog](https://developers.notion.com/page/changelog)(検索結果で確認、ページ全文は未取得)、[Build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client) |
| Notion のリフレッシュトークン | 初回認可から180日が上限、連続30日未更新でも失効。更新のたびにローテーションし、旧トークンの再利用は盗用扱いで接続全体が失効する | [Build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client)(公式・取得済み) |
| Notion ホスト版 MCP の認証 | OAuth のみで Bearer は不可 | [Gamut guide](https://www.gamut.so/blog/notion-mcp-server-setup-guide)(二次情報) |
| Gemini 側の OAuth 要件 | registration\_endpoint(DCR)が必須で CIMD だけでは不可。期限切れ時は grant\_type=refresh\_token を自動送信。更新時は同じリフレッシュトークンを返す前提 | [Google: OAuth 2.1 implementation guide](https://developers.google.com/connected-apps/mcp/oauth)(取得済み。Spark を名指ししていない) |
| Spark のカスタムアプリの認証 | OAuth 前提で、任意の Bearer ヘッダーは文書化されていない | [Plushcap](https://www.plushcap.com/docs/mcp/gemini-web)(二次情報) |
| 他クライアントの前例 | リフレッシュトークンを使わない・更新に失敗する報告が Claude Code、Codex、claude.ai カスタムコネクタにある | [claude-ai-mcp #228](https://github.com/anthropics/claude-ai-mcp/issues/228)、[Codex #6572](https://github.com/openai/codex/issues/6572)、[Claude Code #5706](https://claudeissues.com/issue/5706-missing-token-refresh-mechanism-for-mcp-server-integrations) |
| Gemini Spark と Notion の同症状の報告 | 見つからなかった(Spark の報告は初回 OAuth 失敗が中心) | [例: /token が呼ばれない報告](https://discuss.ai.google.dev/t/gemini-spark-custom-mcp-oauth-stops-after-302-callback-and-never-calls-token/177327) |

| 仮説 | 内容 | Phase 0 での判別方法 |
| --- | --- | --- |
| H1 | Gemini は refresh\_token を使わず、アクセストークンの期限で切れる | アクセストークン寿命を短く(5分)して接続し、/token に grant\_type=refresh\_token が届くかを見る |
| H2 | refresh は使うが、返された新しい refresh token を保存しない(Notion のローテーションと相性が悪い) | ローテーション ON/OFF で、更新に使われる refresh token を比較する |
| H3 | Notion が発行する DCR クライアントの期限切れや、更新時のクライアント ID 不一致 | Notion 直結でのみ発生。ファサード経由なら Notion の OAuth を Gemini が使わないので発生しない(この仮説の根拠は [Bindify の記事](https://bindify-marketing-prod.pages.dev/blog/notion-mcp-auth-management) のみで未検証) |

ファサード方式なら、H1・H2・H3 のどれが真でも対処できる。H1 は長寿命のアクセストークン、H2 はリフレッシュの非ローテーション、H3 は Notion の OAuth を Gemini に見せないことで避ける。

## 全体アーキテクチャ

Gemini が話す相手は Cloud Run 上の1つのサービスだけで、Notion のトークンは Gemini に渡さない。

&#91;embedded content: 全体構成 · Gemini → Cloud Run ファサード → Notion API\]

Gemini は /register と /token で OAuth 部と、/mcp で MCP 部とやり取りする。認可画面だけはオーナーのブラウザで開く。OAuth 部の状態は Firestore に、Notion のトークンと署名鍵は Secret Manager に置く。

## エンドポイント仕様

公開するのは OAuth 用の6つ、MCP 用の1つ、ヘルスチェックの1つ。Gemini はメタデータを自動検出し、検出に失敗すると別 URL を試さずに接続設定で詰まるので、メタデータは必ず 200 で返す。

| パス | メソッド | 役割 | 実装上の要点 |
| --- | --- | --- | --- |
| /.well-known/oauth-protected-resource | GET | 保護リソースのメタデータ | resource = /mcp の URL、authorization\_servers = 自分の issuer |
| /.well-known/oauth-authorization-server | GET | 認可サーバーのメタデータ | registration\_endpoint を必ず含める。grant\_types = authorization\_code, refresh\_token、code\_challenge\_methods = S256、token\_endpoint\_auth\_methods = none |
| /register | POST | クライアント登録(DCR, RFC 7591) | 誰でも登録できてよいが、redirect\_uri は https と Google 系ドメインのみ許可。実際のコールバック URL は Phase 0 でログに記録して確定する |
| /authorize | GET, POST | 認可画面 | オーナー認証(パスワード)を通した後に認可コードを発行。PKCE S256 必須、state をそのまま返す、resource をコードに紐付け |
| /token | POST | トークン発行・更新 | grant\_type = authorization\_code と refresh\_token。コードは1回限り、code\_verifier を検証 |
| /revoke | POST | 失効 | access または refresh token を受け取り、グラントごと無効化。Gemini で連携解除した際に呼ばれる |
| /mcp | POST (GET は 405) | MCP 本体(Streamable HTTP) | Bearer を検証。無効なら 401 と WWW-Authenticate: resource\_metadata=... を返す。ステートレスで動かす |
| /healthz | GET | 死活監視 | 認証なし、中身は ok のみ |

エラーは OAuth の標準形式(error, error\_description)で返す。invalid\_grant は終端エラーとし、トークンの中身や原因をログ・レスポンスに出さない。

## トークン設計

方針は、アクセストークンを設定で寿命を変えられる署名付きトークンにし、リフレッシュトークンはローテーションしないこと。Gemini が更新を使うか・新しいトークンを保存するかが未確定なので、どちらの結果でも動く構成にする。下表の数値は初期値で、環境変数で変えられるようにする。

| 種類 | 形式 | 寿命の初期値 | 設計上の理由 |
| --- | --- | --- | --- |
| 認可コード | ランダム 256bit、Firestore にハッシュで保存 | 60秒、1回限り | PKCE の code\_challenge と redirect\_uri を紐付けて盗用を防ぐ |
| アクセストークン | 署名付き JWT(署名鍵は Secret Manager、kid 付き) | 30日(ACCESS\_TTL で変更。Phase 0 は5分) | Gemini がリフレッシュを使わない場合(H1)に備えて長めにする。使うと分かったら 1〜8時間に短縮する |
| リフレッシュトークン | 不透明なランダム 256bit、Firestore にハッシュで保存 | 最終使用から 90日、絶対上限 365日 | Google のガイドに合わせてローテーションせず、更新時は同じトークンを返して期限だけ延ばす(ROTATE\_REFRESH=true でローテーションを試せる) |
| Notion の資格情報 | Notion のトークン(下の表を参照)。Secret Manager に保存 | トークンの種類による | Gemini には一切見せない |

アクセストークンの JWT には iss、aud(= /mcp の URL)、sub(オーナー)、client\_id、jti、exp を入れる。/revoke された jti は Firestore の失効リストに載せ、/mcp で照合する。署名鍵を変えると発行済みのトークンが全部切れるので、緊急時の全失効手段として使える。

Notion のトークンは、最初は内部インテグレーショントークン(ntn\_ で始まるもの)を推奨する。

| 選択肢 | メリット | 注意点 |
| --- | --- | --- |
| 内部インテグレーショントークン | 共有したページだけに見せられる(最小権限) | Core Memory と Memory DB の親ページを共有する必要がある。共有外のページは見えない(Operating Guide の「Notion 全体を検索」は共有範囲内になる) |
| 個人アクセストークン(PAT) | 自分が見えるページを全部見られる | 有効期限を7日〜1年から選ぶので、期限切れの更新運用が必要(Notion changelog 2026-07-08)。権限が広すぎる |

上のどちらを使うかは実装前に決める。内部インテグレーショントークンの有効期限の有無は未確認。

## データ保存とシークレット

Cloud Run のインスタンスは使い捨てで、複数になりうる。状態はすべて Firestore に置き、秘密情報は Secret Manager に置く。ローカルファイルとメモリには永続的な状態を持たせない。

| コレクション | 主なフィールド | 寿命 |
| --- | --- | --- |
| clients | client\_id、redirect\_uris、client\_name、created\_at | 期限なし(不要になれば手動削除) |
| codes | code のハッシュ、client\_id、redirect\_uri、code\_challenge、resource、used | Firestore の TTL ポリシーで期限後に自動削除 |
| refresh\_tokens | token のハッシュ、client\_id、created\_at、last\_used\_at、expires\_at、revoked | 期限後に TTL で削除 |
| revoked\_jti | 失効したアクセストークンの jti、exp | exp を過ぎたら TTL で削除 |
| events | 観察ログ(Phase 0 用)。時刻、エンドポイント、grant\_type、client\_id、トークンのハッシュの先頭数文字、結果 | 30日で TTL 削除。トークンの全文と Notion の本文は記録しない |

| シークレット | 用途 | 管理 |
| --- | --- | --- |
| NOTION\_TOKEN | Notion API 呼び出し | Secret Manager に保存し、Cloud Run に環境変数として渡す |
| JWT\_SIGNING\_KEY | アクセストークンの署名(kid で世代管理) | 同上。鍵を変えると発行済みのトークンが全部切れる |
| OWNER\_PASSWORD\_HASH | /authorize のオーナー認証 | パスワード自体は保存せず、scrypt または Argon2 のハッシュを置く |

サービスアカウントには Firestore と Secret Manager の最小権限だけを与える。Firestore のロケーションは作成後に変えられないので、Cloud Run と同じリージョン(東京を想定)で作る。

## MCP ツール設計

共通メモリの運用(Operating Guide)に必要な、検索・取得・作成・更新だけを実装する。削除系のツールは作らない。ツール定義が大きいと Gemini のコンテキストを食うので、公式ホスト版より少ない数に絞る。

| ツール | 役割 | Notion API 側 | Phase |
| --- | --- | --- | --- |
| notion\_search | タイトルと本文の検索 | 検索エンドポイント | 1 |
| notion\_fetch | ページの本文を Markdown で取得 | ページ取得 + ブロック取得 | 1 |
| notion\_query\_data\_source | Memory DB の絞り込み取得 | データソースのクエリ | 1 |
| notion\_create\_page | 記憶ページの新規作成 | ページ作成 | 2 |
| notion\_update\_page | プロパティ更新と本文への追記 | ページ更新 + ブロック追加 | 2 |

実装の要点は次のとおり。

- 読み取り専用モード(READ\_ONLY=true)を用意し、Phase 1 ではこれで動かす。書き込みツールは Phase 2 で有効化する。
- ツールには読み取り専用かどうかのアノテーションを付ける。
- Notion API のバージョンは公式のオープンソース版の README の例で使われている 2025-09-03 を基準にし、データソース単位でクエリする。実装時に現行のバージョンを確認する。
- 本文の Markdown 変換は、Notion API が直接対応しているかを実装時に確認し、無ければブロックと Markdown の変換を自前で書く。範囲は見出し・段落・箇条書き・コード・トードを最低限とする。
- オープンソース版(makenotion/notion-mcp-server)は参考実装として読む。公式が「将来終了するかもしれない」と言っているので、依存はしない([リポジトリ](https://github.com/makenotion/notion-mcp-server))。
- 入力はスキーマで厳密に検証し、Notion の ID は UUID 形式以外を拒否する。エラーにはトークンやページ本文を含めない。

## セキュリティ要件

公開エンドポイントに Notion の読み書き権限をぶら下げる設計なので、認可画面とトークン管理を最大の守りどころにする。DCR は誰でも登録できるが、トークンはオーナーが認可画面で承認した場合にしか出さない。

| 脅威 | 対策 |
| --- | --- |
| 認可画面への総当たり | パスワードを scrypt または Argon2 でハッシュ。失敗回数の制限とロックアウトを Firestore で管理。Phase 3 で TOTP またはオーナーの Google アカウント限定のサインインを検討 |
| 認可コードの盗用 | PKCE S256 を必須にする。plain は拒否。コードは60秒、1回限り |
| リダイレクト先の悔用 | redirect\_uri は登録時の値と完全一致を要求。https と Google 系ドメインのみ許可 |
| トークンの漏洩 | リフレッシュトークンはハッシュで保存。ログにトークンを出さない。/revoke と署名鍵の切り替えで緊急失効できる。アクセストークンを長寿命にする間はこの手順を README に書いておく |
| Notion を不正に読み書きされる | 最小権限のトークン。削除ツールを作らない。書き込みは Phase 2 まで無効 |
| Notion の本文に混入した指示(プロンプトインジェクション) | ツール結果はデータとして返す。破壊的なツールを持たせないことが最大の緩和策になる |
| コストの暴走や DoS | Cloud Run の最大インスタンス数を制限し、予算アラートを設定。/register と /authorize にレート制限 |
| シークレットの混入 | リポジトリに .env をコミットしない。.gitignore を実装前に用意し、シークレットスキャンを CI に入れる |

Cloud Run の認証設定は「未認証の呼び出しを許可」にする。Gemini は Google の IAM では入れないので、保護はこのサービス自身の OAuth が担う。リポジトリは最初は非公開にする。

## Cloud Run 構成とデプロイ

1つのサービスに OAuth 部と MCP 部を同居させる。初期値は次のとおりで、Phase 0 の観察と実測で調整する。

| 項目 | 初期値 | 理由 |
| --- | --- | --- |
| リージョン | asia-northeast1(東京) | ユーザーが札幌。Firestore も同じリージョンにする |
| 最小インスタンス | 0 | 個人利用で、費用を最小にする。コールドスタートで Gemini が失敗するようなら 1 にする |
| 最大インスタンス | 2 | コストの暴走と DoS の緩和 |
| 同時実行数 | 80 | 既定値。変更しない |
| リクエストタイムアウト | 300秒 | Streamable HTTP のレスポンスに余裕を持たせる |
| CPU / メモリ | 1 vCPU / 512 MiB | 小さく始めて足りなければ上げる |
| 認証 | 未認証の呼び出しを許可 | Gemini は IAM で入れない。保護は自前の OAuth |
| サービスアカウント | 専用。Firestore ユーザー + Secret Manager アクセサーのみ | 最小権限 |
| シークレット | Secret Manager から環境変数として注入 | コードとイメージに入れない |
| PUBLIC\_BASE\_URL | デプロイ後のサービス URL(将来の独自ドメインにも対応) | issuer とメタデータの URL をこれで組み立てる。変えると発行済みのトークンが無効になる |

デプロイは Dockerfile を置いて gcloud run deploy --source . で始める。継続的デプロイ(GitHub Actions)は Phase 3 で足す。コストは個人利用のリクエスト数だけなら無料枠に収まる見込みだが、試算はしていない。予算アラートを先に設定する。

## 実装フェーズと受け入れ基準

最初に作るのは観察版(Phase 0)で、目的は Gemini の実挙動を数時間で確定させること。ACCESS\_TTL を 5 分にしておけば、数時間で H1 と H2 の結果が出る。

| Phase | 範囲 | 受け入れ基準 |
| --- | --- | --- |
| 0 観察版 | OAuth の6エンドポイント + /mcp にダミーツール(whoami, echo)のみ。Notion は未接続。ACCESS\_TTL=300秒、ROTATE\_REFRESH を切り替え可能。events に全リクエストを記録 | Gemini のカスタムアプリとして接続でき、ダミーツールが呼べる。events から (1) /register の redirect\_uri (2) 期限後に grant\_type=refresh\_token が届くか (3) ローテーション ON のとき2回目以降に使われるトークン、が読み取れる |
| 1 読み取り | Notion 接続(search, fetch, query\_data\_source)、READ\_ONLY=true。ACCESS\_TTL は Phase 0 の結果で決める(H1 が真なら 30日、偽なら 1〜8時間) | Gemini から Core Memory を検索・取得できる。丸一日放置した後も再認可なしで動く |
| 2 書き込み | create\_page と update\_page を有効化 | Memory DB に記憶ページを作成・更新できる。Operating Guide の保存手順(重複確認→更新)が通る |
| 3 運用強化 | レート制限、ロックアウト、TOTP 等の検討、/revoke と鍵切り替えの手順書、予算アラート、CI(シークレットスキャン、継続的デプロイ) | 7日間放置しても再認可なしで動く。緊急失効の手順を実際に試して成功する |
| 4 任意 | Claude / ChatGPT / Antigravity CLI からも同じサーバーを使えるか確認 | 接続できるかを確認する(必須ではない) |

**実装方針**

- 言語は TypeScript(Node 20 以上)を第一候補にする。MCP の公式 TypeScript SDK に認可サーバー向けの補助機能があるはずだが、現行の API は実装時に確認する。Python(FastMCP)でもよい。
- Web フレームワークは軽量なもの(Hono など)。フロントは不要で、認可画面は最小の HTML フォーム1枚でよい。
- 実装エージェントにはこの文書を設計メモとしてリポジトリに置き、フェーズごとに依頼する。一度に全部を依頼しない。

**異常系テスト(最低限)**

- code\_verifier 不一致、認可コードの再利用、redirect\_uri 不一致 → いずれも拒否。
- 期限切れ・失効済みトークンで /mcp → 401 と WWW-Authenticate。
- ROTATE\_REFRESH=false で同じリフレッシュトークンが返る。/revoke 後に更新が失敗する。

## 未確定事項とリスク

最大の不確実性は「Gemini のカスタムアプリがこのサーバーとどう話すか」で、Phase 0 で最初に潰す。以下は実装や運用で確認すること。

| 項目 | 内容 | 確認のタイミング |
| --- | --- | --- |
| 初回接続の失敗 | Spark のカスタムアプリでは、認可コード返却後に /token が呼ばれず接続できないという報告がある([例](https://discuss.ai.google.dev/t/gemini-spark-custom-mcp-oauth-stops-after-302-callback-and-never-calls-token/177327))。原因は不明 | Phase 0 |
| Gemini がリフレッシュを一切使わない場合 | 長寿命アクセストークン(30日)で運用し、期限前に手動で再認可する。漏洩時の影響が大きいので、失効手順を先に用意する | Phase 0 → 1 |
| カスタムアプリの利用条件 | 個人の Google アカウント、Keep Activity オン、米国・英語などの制限があるという情報がある。今後変わる可能性。カスタムアプリは Spark のタスク内でしか使えない | 常時 |
| Notion API とホスト版 MCP の機能差 | ホスト版は Markdown での読み書きやデータベース横断などが多い。自前版は絞ったツールだけ。足りなければツールを足す | Phase 1 |
| Notion トークンの期限 | PAT は期限を選ぶため更新運用が必要。内部インテグレーショントークンの期限は未確認 | Phase 1 前 |
| Notion ホスト版の DCR クライアント期限切れ | Bindify の記事のみで、Notion 公式には記載がない。ファサード方式では関係しないが、根拠は弱い | 参考 |
| 将来の不要化 | Notion が Gemini を公式サポートするか、Gemini がリフレッシュを修正すればこのサーバーは不要になる。その時はアーカイブする | 半年ごとに確認 |
| メモリ運用ルールとの整合 | 共通メモリの「忘れて」「記憶して」は、削除ツールを作らない設計と衝突する。Gemini 側では「削除できない、手動で行う」と伝える運用にする | Phase 2 |

## GitHub リポジトリ名の候補

本命は notion-mcp-oauth-facade。何をするものかが名前だけで分かり、検索でも見つかりやすい。同名リポジトリとの衝突は確認していないので、決める前に GitHub で検索する。

| 候補 | ニュアンス | 強み | 注意点 |
| --- | --- | --- | --- |
| notion-mcp-oauth-facade | 直球。Notion 用の OAuth ファサード | 内容が一目で分かる。検索性が高い | 少し長い |
| gemini-notion-mcp-bridge | Gemini と Notion をつなぐ橋 | 解決したい問題が名前に出る | Gemini や Spark の名前が変わると古くなる |
| mcp-oauth-facade | Notion に限らない汎用の OAuth ファサード | 将来他のサービスを足しても名前を変えない | 一般的すぎて同名がありそう |
| notion-mcp-keepalive | 「切れない」を気持ちよく表現 | 目的が伝わりやすい | 実態は中継で、keepalive という語が技術的にはやや不正確 |
| mcp-doorman | 門番。認可を一手に引き受ける | 覚えやすくて語感がいい。汎用名として使える | 内容が名前からは分からない |
| notion-gate | Notion への閨 | 短い | ゲートウェイ製品と紛らわしい |
| cloudrun-mcp-oauth | Cloud Run 上の MCP の OAuth | 構成が分かる | Cloud Run 以外に移すと名前と合わない |

選び方は、次の3点で決める。

1. 製品名(Gemini / Spark)を入れるか。入れると今の目的は伝わるが、製品名の変更や統合で古くなる。
2. Notion 専用にするか、汎用にするか。今は Notion 専用のツールを持つので、専用名のほうが正確。
3. 公開するか。認証の仕組みを含むので、最初は非公開で作り、シークレットが混ざっていないことを確認してから公開を検討する。
