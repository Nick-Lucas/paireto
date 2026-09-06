* contains plugins which are installed into various agent harnesses
* as a principle, plugin hooks only pass data straight to the extension with minimal remapping and enrichment. No enrichment should take place which is possible to do centrally in the extension unless it is harness implementation specific (such as reading the harnesses own config/state directory)
