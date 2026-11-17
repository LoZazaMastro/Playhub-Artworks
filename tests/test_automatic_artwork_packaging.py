"""The staged backend must retain all local runtime imports; no release/upload."""
import ast
import re
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class AutomaticPackagingTests(unittest.TestCase):
    def test_all_local_backend_imports_are_packaged_by_both_workflows(self):
        tree=ast.parse((ROOT/'main.py').read_text(encoding='utf-8'))
        modules=set()
        for node in ast.walk(tree):
            names=[item.name for item in node.names] if isinstance(node,ast.Import) else [node.module] if isinstance(node,ast.ImportFrom) else []
            for module in names:
                if module and (ROOT/(module+'.py')).is_file():modules.add(module+'.py')
        self.assertIn('automatic_artwork.py',modules)
        for name in ['release.yml','pre-release.yml']:
            source=(ROOT/'.github'/'workflows'/name).read_text(encoding='utf-8')
            block=re.search(r'const includeInBuild = \[(.*?)\];',source,re.S).group(1)
            for module in modules:self.assertIn('"'+module+'"',block,name+': '+module)
