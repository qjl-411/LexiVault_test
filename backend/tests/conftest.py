import pytest

from backend import app as app_module


@pytest.fixture(autouse=True)
def workspace_creation_parent(tmp_path, monkeypatch):
    """Keep new workspaces in a temporary directory without opening a desktop dialog."""
    parent = tmp_path / 'test-workspaces'
    select_directory = app_module.select_workspace_directory

    def select(title):
        if title == '选择新工作空间的保存位置':
            parent.mkdir(exist_ok=True)
            return parent
        return select_directory(title)

    monkeypatch.setattr(app_module, 'select_workspace_directory', select)
