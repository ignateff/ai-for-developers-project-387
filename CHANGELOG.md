# Changelog

## [0.5.0](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.4.1...v0.5.0) (2026-11-03)


### Features

* **deploy:** add explicit Fly deployment pipeline ([1de8f19](https://github.com/ignateff/ai-for-developers-project-386/commit/1de8f19b56d177b257f3fac64960cda8478970cc)), closes [#79](https://github.com/ignateff/ai-for-developers-project-386/issues/79)
* **deploy:** prepare verified local image ([2593381](https://github.com/ignateff/ai-for-developers-project-386/commit/259338175b515cc2e6e6e877e6354119c9212b60)), closes [#78](https://github.com/ignateff/ai-for-developers-project-386/issues/78)
* **tooling:** improve deployment verification and agent guidance ([76723b1](https://github.com/ignateff/ai-for-developers-project-386/commit/76723b1296a6f14f2ff40d724c19519de297b792))


### Bug Fixes

* **deploy:** build from an in-memory Git snapshot ([b62447e](https://github.com/ignateff/ai-for-developers-project-386/commit/b62447e524ef906a6a3b33daae150d96ffe7ca88)), closes [#79](https://github.com/ignateff/ai-for-developers-project-386/issues/79)
* **deploy:** check checkout state before updating refs ([07a60a6](https://github.com/ignateff/ai-for-developers-project-386/commit/07a60a65eb42ccbd1aa65ebd17798f1b3ac6ba3f)), closes [#79](https://github.com/ignateff/ai-for-developers-project-386/issues/79)
* **deploy:** detect build context changes ([f610d52](https://github.com/ignateff/ai-for-developers-project-386/commit/f610d5241f5ca958f6fcc16a2095e10d6f913f7c)), closes [#79](https://github.com/ignateff/ai-for-developers-project-386/issues/79)
* **deploy:** harden preparation git gate ([be4c7ff](https://github.com/ignateff/ai-for-developers-project-386/commit/be4c7ffcb1454be30633e1b382265de917bdc5c8)), closes [#78](https://github.com/ignateff/ai-for-developers-project-386/issues/78)
* **deploy:** reject stopped machines with unverified shutdown causes ([1071088](https://github.com/ignateff/ai-for-developers-project-386/commit/10710888518cb9fdbf9b495a1b61aac191909fd6)), closes [#82](https://github.com/ignateff/ai-for-developers-project-386/issues/82)
* integrate deploy gate safeguards ([8fd41e0](https://github.com/ignateff/ai-for-developers-project-386/commit/8fd41e05cac3d3861b3e1172b25d18280cf92d0b)), closes [#78](https://github.com/ignateff/ai-for-developers-project-386/issues/78)
* **smoke:** reconcile uncertain Docker outcomes and verify context inputs ([ec8f07b](https://github.com/ignateff/ai-for-developers-project-386/commit/ec8f07bdcaa0d8a651f777d2e6048e45b4b06584)), closes [#76](https://github.com/ignateff/ai-for-developers-project-386/issues/76)
* **smoke:** verify inputs and recover owned resources ([f3550d6](https://github.com/ignateff/ai-for-developers-project-386/commit/f3550d6fc87a833b1d8700dc82129ed6268ac82a)), closes [#76](https://github.com/ignateff/ai-for-developers-project-386/issues/76)
* **tooling:** preserve deployment locks and verify recovery outcomes ([892934b](https://github.com/ignateff/ai-for-developers-project-386/commit/892934b0aedf09e252d3ac5f534da0d0941c361b)), closes [#82](https://github.com/ignateff/ai-for-developers-project-386/issues/82)

## [0.4.1](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.4.0...v0.4.1) (2026-11-03)


### Bug Fixes

* **test:** pin SDK boundary lint diagnostics to JSON ([d3040e6](https://github.com/ignateff/ai-for-developers-project-386/commit/d3040e6e11565f79a1e2c58ae3a2c7060e992789)), closes [#68](https://github.com/ignateff/ai-for-developers-project-386/issues/68)

## [0.4.0](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.3.1...v0.4.0) (2026-11-02)


### Features

* **web:** log frontend release and build revision ([2d8e2f1](https://github.com/ignateff/ai-for-developers-project-386/commit/2d8e2f13a1397797a47b5fbc446935e9cd69ed91))
* **web:** log frontend release and build revision ([3941650](https://github.com/ignateff/ai-for-developers-project-386/commit/394165061332289fb59cda085b371db838f2d929)), closes [#64](https://github.com/ignateff/ai-for-developers-project-386/issues/64)

## [0.3.1](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.3.0...v0.3.1) (2026-11-02)


### Bug Fixes

* **tooling:** isolate dev tests and shorten Git hooks ([ba0f41e](https://github.com/ignateff/ai-for-developers-project-386/commit/ba0f41e724e5a8dcd8aeaba2d6b44a7865b087ff))
* **tooling:** isolate dev tests and shorten Git hooks ([df18028](https://github.com/ignateff/ai-for-developers-project-386/commit/df18028ab3716190df8cce9dd3d74746bf230c9b)), closes [#60](https://github.com/ignateff/ai-for-developers-project-386/issues/60)

## [0.3.0](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.2.0...v0.3.0) (2026-11-02)


### Features

* **api:** add safe structured logging ([f1c12c9](https://github.com/ignateff/ai-for-developers-project-386/commit/f1c12c9110839f2931715e978eb15c1d0b60088d)), closes [#54](https://github.com/ignateff/ai-for-developers-project-386/issues/54)
* **web:** add calendar favicon ([11bc396](https://github.com/ignateff/ai-for-developers-project-386/commit/11bc3964feb4dabad4d6b462c28952ac302f7791)), closes [#53](https://github.com/ignateff/ai-for-developers-project-386/issues/53)


### Bug Fixes

* improve safe diagnostics and verify slot refresh race ([920d3c2](https://github.com/ignateff/ai-for-developers-project-386/commit/920d3c2767f07414163210a2d3c70808f20d6ade)), closes [#51](https://github.com/ignateff/ai-for-developers-project-386/issues/51) [#54](https://github.com/ignateff/ai-for-developers-project-386/issues/54)
* **web:** block stale slots after booking conflict ([d4e3d18](https://github.com/ignateff/ai-for-developers-project-386/commit/d4e3d18ed09ad288bd083259c84f5ad0882de4a6)), closes [#51](https://github.com/ignateff/ai-for-developers-project-386/issues/51)
* **web:** correct booking confirmation copy ([04a8dcd](https://github.com/ignateff/ai-for-developers-project-386/commit/04a8dcd51c592c8509231df803d969f71aef2308)), closes [#52](https://github.com/ignateff/ai-for-developers-project-386/issues/52)

## [0.2.0](https://github.com/ignateff/ai-for-developers-project-386/compare/v0.1.0...v0.2.0) (2026-11-02)


### Features

* **api:** add Dockerfile for containerized deployment ([eed024d](https://github.com/ignateff/ai-for-developers-project-386/commit/eed024dbfe7537a12bce3570bd923d47366bc466)), closes [#47](https://github.com/ignateff/ai-for-developers-project-386/issues/47)
* configure Fly.io app with volume and health check ([160be62](https://github.com/ignateff/ai-for-developers-project-386/commit/160be62418cdbb558fa3673a8a27cfe1805d7af6)), closes [#47](https://github.com/ignateff/ai-for-developers-project-386/issues/47)

## 0.1.0 (2026-11-01)


### Features

* align web UI with calendar-booking design ([85d7312](https://github.com/ignateff/ai-for-developers-project-386/commit/85d7312cd3a40ae9ae8be08cd184edd815e978e7))
* call calendar — meeting types, booking, upcoming events ([5557fe7](https://github.com/ignateff/ai-for-developers-project-386/commit/5557fe7874c62530ee333d68f848dbcbf1184323))
* create and list meeting types ([1a8352e](https://github.com/ignateff/ai-for-developers-project-386/commit/1a8352e83b9a4de19a87ff450135b89dc7999520))
* create bookings with safe retries ([02539a4](https://github.com/ignateff/ai-for-developers-project-386/commit/02539a4e682591a25e854c9fb350dc62a2cc6bb9))
* **dev:** support concurrent project instances ([a5ac5b7](https://github.com/ignateff/ai-for-developers-project-386/commit/a5ac5b76d2d1c2e6654153d8762bf0ec2f8c15fa))
* **dev:** support concurrent project instances ([1bd3b55](https://github.com/ignateff/ai-for-developers-project-386/commit/1bd3b550d7162662256cdc43eb36dbba3f63c104))
* manage meeting types with version checks ([697031a](https://github.com/ignateff/ai-for-developers-project-386/commit/697031a7d2ae8cb5e3281798bc7ecc57d17764a4))
* prepare calendar storage and query infrastructure ([ef0b77c](https://github.com/ignateff/ai-for-developers-project-386/commit/ef0b77cb4d13b3325fe5cba5d94b88a144d49541))
* recover uncertain booking attempts ([a0fc448](https://github.com/ignateff/ai-for-developers-project-386/commit/a0fc448f8e40d34ba470f40f29a121be9b89ec59))
* scaffold calendar application ([2892769](https://github.com/ignateff/ai-for-developers-project-386/commit/289276939347c57596b3b82ca826e2e88379dbd5))
* show available meeting slots ([ee5b215](https://github.com/ignateff/ai-for-developers-project-386/commit/ee5b215384ef40be6ae66c130ece3275e95c0f4c))
* show upcoming events ([589e0a3](https://github.com/ignateff/ai-for-developers-project-386/commit/589e0a3d50752d1f7c8dd418115226c7f725fda2))
* **web:** add main page and route stubs ([17ec5d5](https://github.com/ignateff/ai-for-developers-project-386/commit/17ec5d51276fc2ec8f3656d7a8b1dce4f22da788))
* **web:** add Mantine theme with preview page ([21b1a53](https://github.com/ignateff/ai-for-developers-project-386/commit/21b1a537ecd6d78a97d624e901f2a46ffaff391c))
* **web:** separate guest booking and admin ([2afab6b](https://github.com/ignateff/ai-for-developers-project-386/commit/2afab6ba314f2697daf6cffcaf74d4c570a4e778))
* **web:** separate guest booking and admin ([84110c4](https://github.com/ignateff/ai-for-developers-project-386/commit/84110c4073ed06ecc4a23610d1f4999eaf2f7b1f))


### Bug Fixes

* address calendar review findings ([a9e9b86](https://github.com/ignateff/ai-for-developers-project-386/commit/a9e9b86deff08e492b9b3954b24470c436276083))
* align scaffold with booking requirements ([a5f49aa](https://github.com/ignateff/ai-for-developers-project-386/commit/a5f49aa3856464c8e9cacbb6c8bf8250ddd9f4ff))
* **ci:** accept generated release files ([4c54a9e](https://github.com/ignateff/ai-for-developers-project-386/commit/4c54a9ecf9b152a9e71ebc2599ccaecd4d9f96ff))
* **ci:** accept generated release files ([2e18d7e](https://github.com/ignateff/ai-for-developers-project-386/commit/2e18d7e031d329fb7a0698db3d14e2e8d9b65bab)), closes [#38](https://github.com/ignateff/ai-for-developers-project-386/issues/38)
* validate Unicode meeting type lengths ([53366f6](https://github.com/ignateff/ai-for-developers-project-386/commit/53366f684f11bb8e3d63215616ad973cb7079258))
* **web:** refine guest list and meeting type actions ([4e1aad1](https://github.com/ignateff/ai-for-developers-project-386/commit/4e1aad1a7674c1ba50be620b24038210276a222e))
* **web:** resolve meeting type review findings ([e40357d](https://github.com/ignateff/ai-for-developers-project-386/commit/e40357d2b05b3dd40d3cbd29dc0481902c2815cb))
